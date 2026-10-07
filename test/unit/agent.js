import {test} from 'tap'

import {createAgent, createClient, summarizeCalls} from '../../lib/agent.js'
import {normalize} from '../../lib/options.js'

const PAYLOAD = [{
  hash: 'aaa1111'
, fullHash: 'aaa1111000'
, subject: 'add widget'
, type: 'feat'
, scope: 'core'
, breaking: false
, references: []
, breakingNotes: []
, body: ''
}]

const CONTEXT = {cwd: '/tmp/repo', nextRelease: {version: '1.1.0'}}

function agentWith(anthropic, options) {
  return createAgent(options, {createClient: () => { return anthropic }})
}

// Collects warnings too: the coverage retry reports through warn, not log.
function logger() {
  const lines = []
  const errors = []
  function push(message) {
    lines.push(message)
  }
  return {
    lines
  , errors
  , log: push
  , warn: push
  , error: (message) => {
      errors.push(message)
      push(message)
    }
  }
}

// Drives the runner the way the SDK does: yields messages, and lets the script
// fire tool `run` functions so session state advances realistically.
function fakeAnthropic(script) {
  const captured = {params: null}
  return {
    captured
  , beta: {
      messages: {
        toolRunner(params) {
          captured.params = params
          const byName = new Map(params.tools.map((tool) => {
            return [tool.name, tool]
          }))
          // The real runner exposes its live params and grows `messages` as the
          // conversation advances. The rolling cache breakpoint walks that array,
          // so the fake has to have one.
          const state = {...params, messages: [...params.messages]}
          // The real runner yields a turn and only then executes that turn's
          // tools, so a fake that runs them first hides anything that depends on
          // the order -- which is how a submission on the final iteration went
          // unnoticed. `generateToolResponse` is memoised there, so it is here
          // too, and the message it returns is the one pushed.
          let step = null
          let response = null
          async function respond() {
            const content = await byName.get(step.call).run(step.input || {})
            return {
              role: 'user'
            , content: [{type: 'tool_result', tool_use_id: 't', content}]
            }
          }
          return {
            params: state
          , pushMessages() {}
          , generateToolResponse() {
              if (!step.call) return Promise.resolve(null)
              response = response || respond()
              return response
            }
          , async* [Symbol.asyncIterator]() {
              for (step of script) {
                response = null
                const content = step.content || []
                const stopReason = step.stop_reason || 'tool_use'
                yield step.stream || streamOf({
                  stop_reason: stopReason
                , content
                , ...(step.usage ? {usage: step.usage} : {})
                })
                if (step.throws) throw new Error(step.throws)
                state.messages.push({role: 'assistant', content})
                // The SDK resumes a paused turn and runs tools only on tool_use.
                // Every other stop reason ends the run with the tools unrun.
                if (stopReason === 'pause_turn') continue
                if (stopReason !== 'tool_use') return
                const results = await this.generateToolResponse()
                if (results) state.messages.push(results)
              }
            }
          }
        }
      }
    }
  }
}

// The runner streams, so it yields one of the SDK's MessageStreams per turn.
function streamOf(message) {
  return {
    on() {}
  , off() {}
  , abort() {}
  , async finalMessage() { return message }
  }
}

const SUBMISSION = {
  entries: [{
    hashes: ['aaa1111']
  , section: 'features'
  , scope: 'core'
  , headline: 'Adds a widget'
  , details: []
  , importance: 'medium'
  , confidence: 'high'
  }]
, omitted: []
}

test('describe() returns the submission already resolved', async (t) => {
  // Hashes stop existing at this boundary: everything downstream is handed the
  // commits themselves, so there is nothing left to look up and get wrong.
  const options = normalize({}, {env: {ANTHROPIC_API_KEY: 'k'}})
  const anthropic = fakeAnthropic([
    {call: 'read_commit'}
  , {call: 'submit_release_notes', input: SUBMISSION}
  ])

  const agent = agentWith(anthropic, options)
  const result = await agent.describe(PAYLOAD, CONTEXT, logger())

  t.same(
    result.entries[0].commits.map((commit) => { return commit.hash })
  , SUBMISSION.entries[0].hashes
  , 'each entry carries its commits'
  )
  t.same(result.unresolved, [], 'and nothing failed to resolve')
  t.equal(result.payload, PAYLOAD, 'the release travels with it')
})

test('describe() stops as soon as the submit tool fires', async (t) => {
  const options = normalize({}, {env: {ANTHROPIC_API_KEY: 'k'}})
  let after = 0
  const anthropic = fakeAnthropic([
    {call: 'read_commit'}
  , {call: 'submit_release_notes', input: SUBMISSION}
  , {call: 'read_commit'}
  ])

  const log = logger()
  await agentWith(anthropic, options).describe(PAYLOAD, CONTEXT, log)
  after = log.lines.join(' ').includes('read_commit×2') ? 1 : 0
  t.equal(after, 0, 'no further turns are paid for after submission')
  t.match(log.lines.join(' '), /read_commit×1/)
})

test('describe() fails clearly when the agent never submits', async (t) => {
  const options = normalize({}, {env: {ANTHROPIC_API_KEY: 'k'}})
  const anthropic = fakeAnthropic([{call: 'read_commit', stop_reason: 'end_turn'}])

  await t.rejects(
    agentWith(anthropic, options).describe(PAYLOAD, CONTEXT, logger())
  , {code: 'ENOSUBMISSION', message: /end_turn/}
  )
})

test('describe() configures thinking, effort, and a cache breakpoint', async (t) => {
  const options = normalize({effort: 'medium'}, {env: {ANTHROPIC_API_KEY: 'k'}})
  const anthropic = fakeAnthropic([{call: 'submit_release_notes', input: SUBMISSION}])

  await agentWith(anthropic, options).describe(PAYLOAD, CONTEXT, logger())
  const params = anthropic.captured.params

  t.same(params.thinking, {type: 'adaptive'}, 'no budget_tokens')
  t.equal(params.output_config.effort, 'medium')
  t.notOk('temperature' in params, 'sampling params are not sent')
  t.same(params.system[0].cache_control, {type: 'ephemeral'})
  t.equal(params.max_iterations, options.agent.maxIterations)
})

test('describe() reports the tool calls it made', async (t) => {
  const options = normalize({}, {env: {ANTHROPIC_API_KEY: 'k'}})
  const anthropic = fakeAnthropic([
    {call: 'read_diff', input: {hash: 'zzz9999', path: ''}}
  , {call: 'read_commit', input: {hash: 'zzz9999'}}
  , {call: 'read_commit', input: {hash: 'zzz9999'}}
  , {call: 'submit_release_notes', input: SUBMISSION}
  ])

  const log = logger()
  await agentWith(anthropic, options).describe(PAYLOAD, CONTEXT, log)
  // submit_release_notes is deliberately not charged: a budget-exhausted agent
  // is told to submit, so charging for it would deadlock the run.
  t.match(log.lines.join(' '), /3 tool calls/)
  t.match(log.lines.join(' '), /read_commit×2/)
  t.notMatch(log.lines.join(' '), /submit_release_notes×/)
})

test('summarizeCalls() counts by tool name', async (t) => {
  t.equal(summarizeCalls(['a', 'b', 'a']), 'a×2, b×1')
  t.equal(summarizeCalls([]), 'none')
})

test('createAgent() builds a real client when none is injected', async (t) => {
  const options = normalize({}, {env: {ANTHROPIC_API_KEY: 'k'}})
  t.equal(typeof createAgent(options).describe, 'function')
})

test('createAgent() honors a custom base url', async (t) => {
  const env = {ANTHROPIC_API_KEY: 'k'}
  const options = normalize({baseUrl: 'https://proxy.example.com'}, {env})
  t.equal(typeof createAgent(options).describe, 'function')
})

test('describe() leaves a paused turn for the runner to resume', async (t) => {
  // The runner sends a paused turn back by itself. Pushing it here as well would
  // mark the runner mutated, and it would then skip its own stop-reason handling.
  const options = normalize({}, {env: {ANTHROPIC_API_KEY: 'k'}})
  const pushed = []
  const anthropic = fakeAnthropic([
    {call: 'read_commit', stop_reason: 'pause_turn'}
  , {call: 'submit_release_notes', input: SUBMISSION}
  ])
  const inner = anthropic.beta.messages.toolRunner
  anthropic.beta.messages.toolRunner = (params) => {
    const runner = inner(params)
    runner.pushMessages = (message) => { pushed.push(message) }
    return runner
  }

  const log = logger()
  const result = await agentWith(anthropic, options).describe(PAYLOAD, CONTEXT, log)

  t.equal(result.entries.length, 1, 'the run finishes after resuming')
  t.same(pushed, [], 'nothing is pushed')
  t.notMatch(log.lines.join(' '), /read_commit/, 'and the paused turn runs no tools')
})

test('describe() runs no tools from a turn cut off at max_tokens', async (t) => {
  // A turn that ran out of tokens can hold a tool call cut off mid-argument.
  const options = normalize({}, {env: {ANTHROPIC_API_KEY: 'k'}})
  const anthropic = fakeAnthropic([
    {call: 'submit_release_notes', input: SUBMISSION, stop_reason: 'max_tokens'}
  ])

  await t.rejects(
    agentWith(anthropic, options).describe(PAYLOAD, CONTEXT, logger())
  , {
      code: 'ENOSUBMISSION'
    , message: /max_tokens/
    , details: /Raise `agent\.maxTokens` or lower `effort`/
    }
  )
})

test('describe() reports a run that produced no messages at all', async (t) => {
  const options = normalize({}, {env: {ANTHROPIC_API_KEY: 'k'}})
  const anthropic = fakeAnthropic([])

  await t.rejects(
    agentWith(anthropic, options).describe(PAYLOAD, CONTEXT, logger())
  , {code: 'ENOSUBMISSION'}
  )
})

test('createClient() builds a first-party client by default', async (t) => {
  const client = await createClient(normalize({}, {env: {ANTHROPIC_API_KEY: 'k'}}))
  t.equal(client.baseURL, 'https://api.anthropic.com')
})

test('createClient() builds a bedrock client pointed at the region', async (t) => {
  const options = normalize({provider: 'bedrock', region: 'us-east-1'}, {env: {}})
  const client = await createClient(options)

  t.equal(client.baseURL, 'https://bedrock-mantle.us-east-1.api.aws/anthropic')
  t.equal(
    typeof client.beta.messages.toolRunner
  , 'function'
  , 'the agent loop works unchanged on bedrock'
  )
})

test('describe() omits the cache breakpoint when caching is off', async (t) => {
  const options = normalize({promptCaching: false}, {env: {ANTHROPIC_API_KEY: 'k'}})
  const anthropic = fakeAnthropic([{call: 'submit_release_notes', input: SUBMISSION}])

  await agentWith(anthropic, options).describe(PAYLOAD, CONTEXT, logger())
  t.notOk(anthropic.captured.params.system[0].cache_control)
})

test('createClient() explains a missing bedrock sdk rather than crashing', async (t) => {
  const options = normalize({provider: 'bedrock', region: 'us-east-1'}, {env: {}})
  function importBedrock() {
    return Promise.reject(new Error("Cannot find package '@anthropic-ai/bedrock-sdk'"))
  }

  await t.rejects(
    createClient(options, {importBedrock})
  , {code: 'ENOBEDROCKSDK', message: /@anthropic-ai\/bedrock-sdk/}
  )
})

test('createClient() sends a base url to anthropic and never to bedrock', async (t) => {
  // ANTHROPIC_BASE_URL is exported by anyone routing Claude through a gateway, and
  // a SigV4-signed request cannot be answered by one.
  const captured = []
  function importBedrock() {
    return {AnthropicBedrockMantle: class {
      constructor(opts) { captured.push(opts) }
    }}
  }
  const env = {ANTHROPIC_API_KEY: 'k', ANTHROPIC_BASE_URL: 'https://proxy.internal'}

  const direct = await createClient(normalize({}, {env}))
  t.equal(direct.baseURL, 'https://proxy.internal', 'honoured for the direct API')

  await createClient(
    normalize({provider: 'bedrock', region: 'us-east-1'}, {env})
  , {importBedrock}
  )
  t.notOk(captured[0].baseURL, 'and dropped for bedrock')
})

test('describe() reports token usage for the run', async (t) => {
  const options = normalize({}, {env: {ANTHROPIC_API_KEY: 'k'}})
  const anthropic = fakeAnthropic([
    {call: 'read_commit', usage: {input_tokens: 1200, output_tokens: 90}}
  , {
      call: 'submit_release_notes'
    , input: SUBMISSION
    , usage: {input_tokens: 40, output_tokens: 310}
    }
  ])

  const log = logger()
  await agentWith(anthropic, options).describe(PAYLOAD, CONTEXT, log)

  t.match(log.lines.join(' '), /Token usage: 2 turns, 1,240 in, 400 out/)
})

const PARTIAL = {
  entries: [{
    hashes: ['aaa1111']
  , section: 'features'
  , scope: 'core'
  , headline: 'Only one'
  , details: []
  , importance: 'medium'
  , confidence: 'high'
  }]
, omitted: []
}

const TWO_COMMITS = [
  PAYLOAD[0]
, {
    hash: 'bbb2222'
  , fullHash: 'bbb2222000'
  , subject: 'second thing'
  , type: 'fix'
  , scope: 'core'
  , breaking: false
  , references: []
  , breakingNotes: []
  , body: ''
  }
]

test('describe() lets the submit tool do the asking', async (t) => {
  // The loop used to push a user message a turn later, which wasted the request
  // that had already gone out and made the runner drop the turn it interrupted.
  const options = normalize({}, {env: {ANTHROPIC_API_KEY: 'k'}})
  const pushed = []
  const anthropic = fakeAnthropic([
    {call: 'submit_release_notes', input: PARTIAL}
  , {call: 'submit_release_notes', input: {
      ...PARTIAL
    , omitted: [{hash: 'bbb2222', reason: 'trivial'}]
    }}
  ])
  const inner = anthropic.beta.messages.toolRunner
  anthropic.beta.messages.toolRunner = (params) => {
    const runner = inner(params)
    runner.pushMessages = (message) => { pushed.push(message) }
    return runner
  }

  const agent = agentWith(anthropic, options)
  const result = await agent.describe(TWO_COMMITS, CONTEXT, logger())

  t.equal(pushed.length, 0, 'no message is pushed, so no turn is dropped')
  t.equal(result.omitted.length, 1, 'the second attempt is the one kept')
})

test('describe() keeps the best submission, not the last', async (t) => {
  // Asked to account for a missing commit, the agent resubmitted only the entry it
  // reworked. Returning that would have sent 68 commits through the literal-entry
  // fallback, so the earlier, fuller attempt wins.
  const options = normalize({}, {env: {ANTHROPIC_API_KEY: 'k'}})
  const shrunk = {entries: [], omitted: []}
  const anthropic = fakeAnthropic([
    {call: 'submit_release_notes', input: PARTIAL}
  , {call: 'submit_release_notes', input: shrunk}
  , {call: 'submit_release_notes', input: shrunk}
  ])

  const agent = agentWith(anthropic, options)
  const result = await agent.describe(TWO_COMMITS, CONTEXT, logger())

  t.equal(result.entries.length, 1, 'the fuller attempt survives a worse retry')
})

test('describe() gives up asking after the retry budget', async (t) => {
  const env = {ANTHROPIC_API_KEY: 'k'}
  const options = normalize({}, {env})
  options.agent.maxSubmissionRetries = 1
  const anthropic = fakeAnthropic([
    {call: 'submit_release_notes', input: PARTIAL}
  , {call: 'submit_release_notes', input: PARTIAL}
  , {call: 'submit_release_notes', input: PARTIAL}
  ])

  const agent = agentWith(anthropic, options)
  const result = await agent.describe(TWO_COMMITS, CONTEXT, logger())
  t.same(
    result.entries[0].commits.map((commit) => { return commit.hash })
  , PARTIAL.entries[0].hashes
  , 'the best submission stands; the coverage rail takes over'
  )
})

test('describe() does not ask again when coverage is complete', async (t) => {
  const options = normalize({}, {env: {ANTHROPIC_API_KEY: 'k'}})
  const anthropic = fakeAnthropic([{call: 'submit_release_notes', input: SUBMISSION}])

  const log = logger()
  await agentWith(anthropic, options).describe(PAYLOAD, CONTEXT, log)
  t.notMatch(log.lines.join(' '), /asking again/)
})

test('describe() reports hashes that name no commit', async (t) => {
  // These are not a judgement the agent made, so asking again cannot fix them.
  // Unreported, they are indistinguishable from an agent that forgot the release.
  const options = normalize({}, {env: {ANTHROPIC_API_KEY: 'k'}})
  const ghost = {
    entries: [{
      hashes: ['deadbee', 'f00ba47']
    , section: 'features'
    , scope: 'core'
    , headline: 'Named nothing'
    , details: []
    , importance: 'medium'
    , confidence: 'high'
    }]
  , omitted: [{hash: 'aaa1111', reason: 'trivial'}]
  }
  const anthropic = fakeAnthropic([
    {call: 'submit_release_notes', input: ghost}
  , {call: 'submit_release_notes', input: ghost}
  , {call: 'submit_release_notes', input: ghost}
  ])

  const log = logger()
  await agentWith(anthropic, options).describe(PAYLOAD, CONTEXT, log)

  const errors = log.errors.join(' ')
  t.match(errors, /named 2 hashes matching no commit/, 'the count is reported')
  t.match(errors, /deadbee, f00ba47/, 'and each one by name')
})

function cacheMarks(messages) {
  return messages.flatMap((message, index) => {
    const blocks = Array.isArray(message.content) ? message.content : []
    return blocks.some((block) => { return block.cache_control }) ? [index] : []
  })
}

test('describe() does not mark the caller\'s own messages array', async (t) => {
  // Without this only the system block is ever cached, and every turn pays full
  // price for a context that grows into the tens of thousands of tokens.
  const options = normalize({}, {env: {ANTHROPIC_API_KEY: 'k'}})
  const anthropic = fakeAnthropic([
    {call: 'read_commit'}
  , {call: 'read_commit'}
  , {call: 'submit_release_notes', input: SUBMISSION}
  ])

  await agentWith(anthropic, options).describe(PAYLOAD, CONTEXT, logger())

  const marks = cacheMarks(anthropic.captured.params.messages)
  t.equal(marks.length, 0, 'the array handed to the runner is not the live one')
})

test('markCachePoint() keeps at most two points, always at the end', async (t) => {
  const options = normalize({}, {env: {ANTHROPIC_API_KEY: 'k'}})
  const seen = []
  const anthropic = fakeAnthropic([
    {call: 'read_commit'}
  , {call: 'read_commit'}
  , {call: 'read_commit'}
  , {call: 'submit_release_notes', input: SUBMISSION}
  ])
  const inner = anthropic.beta.messages.toolRunner
  anthropic.beta.messages.toolRunner = (params) => {
    const runner = inner(params)
    const iterate = runner[Symbol.asyncIterator].bind(runner)
    runner[Symbol.asyncIterator] = async function* wrapped() {
      for await (const message of iterate()) {
        yield message
        seen.push(cacheMarks(runner.params.messages))
      }
    }
    return runner
  }

  await agentWith(anthropic, options).describe(PAYLOAD, CONTEXT, logger())

  t.ok(seen.length >= 3, 'several turns ran')
  for (const marks of seen) {
    t.ok(marks.length <= 2, `at most two points, saw ${marks.length}`)
  }
  const last = seen[seen.length - 1]
  t.ok(last.length > 0, 'the conversation carries a breakpoint at the end of the run')
})

test('describe() marks nothing when prompt caching is off', async (t) => {
  const env = {ANTHROPIC_API_KEY: 'k'}
  const options = normalize({promptCaching: false}, {env})
  const anthropic = fakeAnthropic([
    {call: 'read_commit'}
  , {call: 'submit_release_notes', input: SUBMISSION}
  ])
  const inner = anthropic.beta.messages.toolRunner
  let runner = null
  anthropic.beta.messages.toolRunner = (params) => {
    runner = inner(params)
    return runner
  }

  await agentWith(anthropic, options).describe(PAYLOAD, CONTEXT, logger())
  t.same(cacheMarks(runner.params.messages), [], 'no breakpoint is placed')
})

test('describe() leaves a turn with no content blocks unmarked', async (t) => {
  const options = normalize({}, {env: {ANTHROPIC_API_KEY: 'k'}})
  const anthropic = fakeAnthropic([
    {stop_reason: 'pause_turn'}
  , {call: 'submit_release_notes', input: SUBMISSION}
  ])
  const inner = anthropic.beta.messages.toolRunner
  let runner = null
  anthropic.beta.messages.toolRunner = (params) => {
    runner = inner(params)
    return runner
  }

  await agentWith(anthropic, options).describe(PAYLOAD, CONTEXT, logger())

  const empty = runner.params.messages.filter((message) => {
    return Array.isArray(message.content) && !message.content.length
  })
  t.ok(empty.length, 'the run produced a message with nothing in it')
  t.ok(cacheMarks(runner.params.messages).length, 'and the breakpoint survived it')
})

test('describe() logs every turn and submission when verbose', async (t) => {
  const options = normalize({verbose: true}, {env: {ANTHROPIC_API_KEY: 'k'}})
  const anthropic = fakeAnthropic([
    {call: 'read_commit', usage: {input_tokens: 10, output_tokens: 5}}
  , {call: 'submit_release_notes', input: SUBMISSION}
  ])

  const log = logger()
  await agentWith(anthropic, options).describe(PAYLOAD, CONTEXT, log)

  const lines = log.lines.join('\n')
  t.match(lines, /system: \d+ chars/)
  t.match(lines, /turn 1: stop=tool_use in=10 out=5/)
  t.match(lines, / {2}read_commit {} -> \d+ chars/)
  t.match(lines, /submission 1: 1 entries, 0 omitted, 0 unresolved, 0 unaccounted/)
  t.match(lines, /^run: /m, 'the resolved config opens the report')
  t.match(lines, /^kickoff: \d+ chars/m)
  t.match(lines, /^finished: /m, 'and the totals close it')
})

test('describe() reports every submission attempt separately', async (t) => {
  // Two retries that change nothing look like one problem unless each is its own
  // line, and that repetition is the signal the agent cannot comply.
  const options = normalize({verbose: true}, {env: {ANTHROPIC_API_KEY: 'k'}})
  const anthropic = fakeAnthropic([
    {call: 'submit_release_notes', input: PARTIAL}
  , {call: 'submit_release_notes', input: PARTIAL}
  , {call: 'submit_release_notes', input: PARTIAL}
  ])

  const log = logger()
  await agentWith(anthropic, options).describe(TWO_COMMITS, CONTEXT, log)

  const attempts = log.lines.filter((line) => { return line.startsWith('submission ') })
  t.equal(attempts.length, 3, 'each attempt gets its own line')
  t.match(attempts[2], /submission 3:.*1 unaccounted/, 'the same gap three times over')
})

test('describe() stays quiet without verbose', async (t) => {
  const options = normalize({}, {env: {ANTHROPIC_API_KEY: 'k'}})
  const anthropic = fakeAnthropic([{call: 'submit_release_notes', input: SUBMISSION}])

  const log = logger()
  await agentWith(anthropic, options).describe(PAYLOAD, CONTEXT, log)
  t.notMatch(log.lines.join('\n'), /turn 1: stop=/)
})

test('describe() keeps a submission made on the last allowed iteration', async (t) => {
  // The runner yields a turn before executing its tools, so the final turn's
  // submission lands after the loop has already ended. It used to be discarded and
  // the whole release fell through to the fallback changelog.
  const options = normalize({agent: {maxIterations: 2}}, {env: {ANTHROPIC_API_KEY: 'k'}})
  const anthropic = fakeAnthropic([
    {call: 'read_commit'}
  , {call: 'submit_release_notes', input: SUBMISSION}
  ])

  const result = await agentWith(anthropic, options).describe(PAYLOAD, CONTEXT, logger())
  t.equal(result.entries.length, 1)
})

test('describe() still throws when it fails with nothing submitted', async (t) => {
  const options = normalize({}, {env: {ANTHROPIC_API_KEY: 'k'}})
  const anthropic = fakeAnthropic([])
  const inner = anthropic.beta.messages.toolRunner
  anthropic.beta.messages.toolRunner = (params) => {
    const runner = inner(params)
    runner[Symbol.asyncIterator] = () => {
      return {
        next: () => {
          return Promise.reject(new Error('Failed to resolve AWS credentials'))
        }
      }
    }
    return runner
  }

  await t.rejects(
    agentWith(anthropic, options).describe(PAYLOAD, CONTEXT, logger())
  , /Failed to resolve AWS credentials/
  , 'a failure with nothing to keep is still a failure'
  )
})

test('describe() records what a turn said as well as why it stopped', async (t) => {
  // Sonnet ends runs with stop_reason end_turn and no submission. Without the text
  // there is nothing to tell a model that gave up from one that wrote its answer
  // into a message instead of calling the tool.
  const options = normalize({verbose: true}, {env: {ANTHROPIC_API_KEY: 'k'}})
  const anthropic = fakeAnthropic([
    {content: [{type: 'text', text: 'Here is the changelog you asked for.'}]}
  , {call: 'submit_release_notes', input: SUBMISSION}
  ])

  const log = logger()
  await agentWith(anthropic, options).describe(PAYLOAD, CONTEXT, log)

  t.match(log.lines.join('\n'), /said="Here is the changelog you asked for\."/)
})

test('describe() records a turn the server sent no content for', async (t) => {
  const options = normalize({verbose: true}, {env: {ANTHROPIC_API_KEY: 'k'}})
  const anthropic = fakeAnthropic([{call: 'submit_release_notes', input: SUBMISSION}])
  const inner = anthropic.beta.messages.toolRunner
  anthropic.beta.messages.toolRunner = (params) => {
    const runner = inner(params)
    const iterate = runner[Symbol.asyncIterator].bind(runner)
    runner[Symbol.asyncIterator] = async function* bare() {
      for await (const stream of iterate()) {
        const message = await stream.finalMessage()
        yield streamOf({stop_reason: message.stop_reason, usage: message.usage})
      }
    }
    return runner
  }

  const log = logger()
  await agentWith(anthropic, options).describe(PAYLOAD, CONTEXT, log)
  t.match(log.lines.join('\n'), /turn 1: stop=/, 'the turn is still recorded')
})

test('describe() keeps an incomplete submission when the retry fails', async (t) => {
  // The first answer left a commit unaccounted for, so the run asked again and the
  // next request died. An incomplete release still beats a fallback changelog.
  const options = normalize({}, {env: {ANTHROPIC_API_KEY: 'k'}})
  const anthropic = fakeAnthropic([
    {call: 'submit_release_notes', input: PARTIAL}
  , {'call': 'read_commit', 'throws': 'Failed to resolve AWS credentials'}
  ])

  const log = logger()
  const result = await agentWith(anthropic, options).describe(TWO_COMMITS, CONTEXT, log)

  t.equal(result.entries.length, 1, 'the partial answer survives')
  t.match(log.lines.join(' '), /stopped after submitting/)
})

test('describe() still throws when the run fails with nothing in hand', async (t) => {
  const options = normalize({}, {env: {ANTHROPIC_API_KEY: 'k'}})
  const anthropic = fakeAnthropic([
    {'call': 'read_commit', 'throws': 'Failed to resolve AWS credentials'}
  ])

  await t.rejects(
    agentWith(anthropic, options).describe(PAYLOAD, CONTEXT, logger())
  , /Failed to resolve AWS credentials/
  )
})

test('createClient() always sets a request timeout', async (t) => {
  // Left unset, the SDK sizes the timeout from max_tokens instead of the option.
  const captured = []
  function importBedrock() {
    return {AnthropicBedrockMantle: class {
      constructor(opts) { captured.push(opts) }
    }}
  }
  const config = {provider: 'bedrock', region: 'us-east-1'}

  await createClient(normalize(config, {env: {}}), {importBedrock})
  t.equal(captured[0].timeout, 600000, 'the default of ten minutes')

  await createClient(normalize({...config, timeout: 120000}, {env: {}}), {importBedrock})
  t.equal(captured[1].timeout, 120000)
})

test('describe() reports unresolved hashes on a last-iteration submission', async (t) => {
  // The post-loop pass used to skip the report the in-loop one performs, so a
  // submission landing on the final turn lost the only line naming the cause.
  const options = normalize({agent: {maxIterations: 2}}, {env: {ANTHROPIC_API_KEY: 'k'}})
  const ghost = {
    entries: [{
      hashes: ['deadbee']
    , supporting: []
    , section: 'features'
    , scope: 'core'
    , headline: 'Named nothing'
    , details: []
    , importance: 'medium'
    , confidence: 'high'
    }]
  , omitted: []
  }
  const anthropic = fakeAnthropic([
    {call: 'read_commit'}
  , {call: 'submit_release_notes', input: ghost}
  ])

  const log = logger()
  await agentWith(anthropic, options).describe(PAYLOAD, CONTEXT, log)

  t.match(log.errors.join(' '), /named 1 hashes matching no commit/)
  t.match(log.errors.join(' '), /deadbee/)
})

test('describe() streams each turn', async (t) => {
  // A turn at the higher efforts can outlast the ten minutes the API allows a
  // request that does not stream.
  const options = normalize({}, {env: {ANTHROPIC_API_KEY: 'k'}})
  const anthropic = fakeAnthropic([{call: 'submit_release_notes', input: SUBMISSION}])

  await agentWith(anthropic, options).describe(PAYLOAD, CONTEXT, logger())
  t.equal(anthropic.captured.params.stream, true)
})

test('describe() passes on a stream error it did not cause', async (t) => {
  const options = normalize({}, {env: {ANTHROPIC_API_KEY: 'k'}})
  const failed = {
    ...streamOf(null)
  , async finalMessage() { throw new Error('overloaded_error') }
  }
  const anthropic = fakeAnthropic([{stream: failed}])

  await t.rejects(
    agentWith(anthropic, options).describe(PAYLOAD, CONTEXT, logger())
  , {message: 'overloaded_error'}
  )
})
