import {test} from 'tap'

import {build} from '../../lib/commits.js'
import {createAgent} from '../../lib/agent.js'
import {describe} from '../../lib/repository.js'
import {normalize} from '../../lib/options.js'
import {STALL, describeEverything, startFakeApi, toolUse} from '../fixtures/fake-api.js'

const QUIET = {log() {}, warn() {}, error() {}}
const COMMITS = [
  {hash: 'a'.repeat(40), message: 'feat(core): add the widget'}
, {hash: 'b'.repeat(40), message: 'chore(deps): bump the parser'}
]

// The first submission names nothing, so the plugin answers it and the SDK has to
// carry that tool result into a second request. The second one covers everything.
function emptyThenEverything(body, index) {
  if (index === 0) return [toolUse('submit_release_notes', {entries: [], omitted: []})]
  return describeEverything(body, 0)
}

// Every other agent test replaces the client, so the request the SDK builds, its
// tool loop and its response parsing were only ever exercised against the real
// API. This runs the real SDK against a local stand-in and reads what it sent.
test('the real SDK sends the request the agent builds', async (t) => {
  const api = await startFakeApi(t, emptyThenEverything)
  const options = normalize({baseUrl: api.url}, {env: {ANTHROPIC_API_KEY: 'test-key'}})
  const payload = build(COMMITS, options, {}, describe(''))

  const resolved = await createAgent(options).describe(payload, {}, QUIET)

  t.equal(api.requests.length, 2, 'the agent stops once the notes are recorded')
  const [first, second] = api.requests
  t.equal(first.headers['x-api-key'], 'test-key')
  t.match(first.url, /^\/v1\/messages/)

  const {body} = first
  t.equal(body.model, 'claude-opus-5-5')
  t.equal(body.max_tokens, 24000)
  t.same(body.thinking, {type: 'adaptive'})
  t.same(body.output_config, {effort: 'high'})
  t.same(body.system[0].cache_control, {type: 'ephemeral'})
  t.equal(body.tool_choice, undefined, 'forced tool use is rejected by the model')
  t.equal(body.stream, true, 'every turn streams')
  t.same(
    body.tools.map((tool) => { return tool.name }).sort()
  , ['grep', 'read_commit', 'read_diff', 'read_file', 'submit_release_notes']
  )
  for (const tool of body.tools) t.equal(tool.input_schema.type, 'object', tool.name)

  const results = second.body.messages.at(-1).content.filter((block) => {
    return block.type === 'tool_result'
  })
  t.equal(results.length, 1, 'the refused submission is answered in the next request')
  t.match(JSON.stringify(results[0].content), /Not recorded/)

  t.equal(resolved.entries.length, 1)
  t.equal(resolved.omitted.length, 1)
})

test('every request ends on a cache point', async (t) => {
  // The runner adds a turn's tool results after the agent has seen the turn, so a
  // point placed on the last message it held left each request's newest turn out
  // of the cached prefix, and the kickoff out of the first one.
  const api = await startFakeApi(t, (body, index) => {
    if (index < 3) return [toolUse('read_commit', {hash: 'a'.repeat(7)})]
    return describeEverything(body, 0)
  })
  const options = normalize({baseUrl: api.url}, {env: {ANTHROPIC_API_KEY: 'test-key'}})
  const payload = build(COMMITS, options, {}, describe(''))

  await createAgent(options).describe(payload, {cwd: process.cwd()}, QUIET)

  t.equal(api.requests.length, 4)
  for (const [index, {body}] of api.requests.entries()) {
    const marked = body.messages.flatMap((message, position) => {
      return message.content
        .filter((block) => { return block.cache_control })
        .map(() => { return position })
    })
    const end = body.messages.length - 1
    t.equal(marked.at(-1), end, `request ${index} marks its last message`)
    t.ok(marked.length <= 2, `and keeps at most two points, saw ${marked.length}`)
  }
})

test('the real SDK leaves the cache points off when caching is off', async (t) => {
  const api = await startFakeApi(t, describeEverything)
  const config = {baseUrl: api.url, promptCaching: false}
  const options = normalize(config, {env: {ANTHROPIC_API_KEY: 'test-key'}})
  const payload = build(COMMITS, options, {}, describe(''))

  await createAgent(options).describe(payload, {}, QUIET)

  t.equal(api.requests[0].body.system[0].cache_control, undefined)
  t.equal(api.requests[0].body.messages[0].content[0].cache_control, undefined)
})

test('the real SDK gives up on a stream that stops sending', async (t) => {
  const api = await startFakeApi(t, () => { return STALL })
  const config = {baseUrl: api.url, timeout: 1000, maxRetries: 0}
  const options = normalize(config, {env: {ANTHROPIC_API_KEY: 'test-key'}})
  const payload = build(COMMITS, options, {}, describe(''))

  const started = Date.now()
  await t.rejects(
    createAgent(options).describe(payload, {}, QUIET)
  , {code: 'ESTREAMSTALLED', message: /sent nothing for 1000 ms/}
  )
  t.ok(Date.now() - started < 5000, 'within the timeout, not the test runner\'s')
})
