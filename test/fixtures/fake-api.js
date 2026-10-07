import {createServer} from 'node:http'

// A stand-in for the Anthropic Messages API, so the real SDK, the real agent loop
// and the real binaries run end to end with no key and no network. Each request is
// recorded. `respond` receives the request body and how many requests came before
// it, and returns the content blocks to reply with, null to end the turn, or STALL
// to start a streamed reply and never finish it.
const STALL = Symbol('stall')

async function startFakeApi(t, respond) {
  const requests = []
  const server = createServer((req, res) => {
    const chunks = []
    req.on('data', (chunk) => { chunks.push(chunk) })
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      requests.push({url: req.url, headers: req.headers, body})
      // A responder that throws would otherwise leave the SDK waiting for a reply.
      // A 400 is one it does not retry, so the error reaches the test at once.
      try {
        const content = respond(body, requests.length - 1)
        if (content === STALL) {
          res.writeHead(200, {'content-type': 'text/event-stream'})
          res.write(event('message_start', {message: reply(body, [], requests.length)}))
          return
        }
        const message = reply(body, content, requests.length)
        if (body.stream) {
          res.writeHead(200, {'content-type': 'text/event-stream'})
          res.end(streamed(message))
          return
        }
        res.writeHead(200, {'content-type': 'application/json'})
        res.end(JSON.stringify(message))
      } catch (err) {
        res.writeHead(400, {'content-type': 'application/json'})
        res.end(JSON.stringify({
          type: 'error'
        , error: {type: 'invalid_request_error', message: err.message}
        }))
      }
    })
  })

  await new Promise((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  // The SDK keeps its connections alive, and close() waits for every one.
  t.teardown(() => {
    server.closeAllConnections()
    return new Promise((resolve) => { server.close(resolve) })
  })
  return {url: `http://127.0.0.1:${server.address().port}`, requests}
}

function reply(body, content, index) {
  const blocks = content || [{type: 'text', text: 'Done.'}]
  return {
    id: `msg_${index}`
  , type: 'message'
  , role: 'assistant'
  , model: body.model
  , content: blocks
  , stop_reason: blocks.some((block) => { return block.type === 'tool_use' })
      ? 'tool_use'
      : 'end_turn'
  , stop_sequence: null
  , usage: {
      input_tokens: 100
    , output_tokens: 20
    , cache_creation_input_tokens: 0
    , cache_read_input_tokens: 0
    }
  }
}

// The server-sent events the API streams a message as. Tool input arrives in two
// pieces, so the SDK has to put the JSON back together.
function streamed(message) {
  const events = [
    event('message_start', {message: {...message, content: [], stop_reason: null}})
  ]
  message.content.forEach((block, index) => {
    if (block.type === 'tool_use') {
      const json = JSON.stringify(block.input)
      const half = Math.floor(json.length / 2)
      events.push(
        event('content_block_start', {index, content_block: {...block, input: {}}})
      , delta(index, {type: 'input_json_delta', partial_json: json.slice(0, half)})
      , delta(index, {type: 'input_json_delta', partial_json: json.slice(half)})
      )
    } else {
      events.push(
        event('content_block_start', {index, content_block: {...block, text: ''}})
      , delta(index, {type: 'text_delta', text: block.text})
      )
    }
    events.push(event('content_block_stop', {index}))
  })
  events.push(
    event('message_delta', {
      delta: {stop_reason: message.stop_reason, stop_sequence: null}
    , usage: {output_tokens: message.usage.output_tokens}
    })
  , event('message_stop', {})
  )
  return events.join('')
}

function delta(index, value) {
  return event('content_block_delta', {index, delta: value})
}

function event(type, data) {
  return `event: ${type}\ndata: ${JSON.stringify({type, ...data})}\n\n`
}

let calls = 0
function toolUse(name, input) {
  return {type: 'tool_use', id: `toolu_${++calls}`, name, input}
}

// The commit rows of the opening prompt, `hash | type(scope) | subject`. The agent
// turns that prompt into content blocks once it marks cache points on it.
function commitsIn(body) {
  const first = body.messages[0].content
  const kickoff = typeof first === 'string'
    ? first
    : first.map((block) => { return block.text || '' }).join('\n')
  const row = /^([0-9a-f]{7,40}) \| (\w*)(?:\((.*?)\))? \| ([^|\n]+)/gm
  return [...kickoff.matchAll(row)].map(([, hash, type, scope, subject]) => {
    return {hash, type, scope: scope || '', subject: subject.trim()}
  })
}

const SECTIONS = {feat: 'features', fix: 'fixes', perf: 'performance'}

// Describes every commit whose type has a conventional section, with its subject
// as the headline, omits the rest, and ends the turn once the notes are recorded.
function describeEverything(body, index) {
  if (index > 0) return null
  const commits = commitsIn(body)
  const described = commits.filter((commit) => { return SECTIONS[commit.type] })
  return [toolUse('submit_release_notes', {
    entries: described.map((commit) => {
      return {
        hashes: [commit.hash]
      , supporting: []
      , section: SECTIONS[commit.type]
      , scope: commit.scope
      , headline: commit.subject
      , details: []
      , importance: 'medium'
      , confidence: 'high'
      }
    })
  , omitted: commits.filter((commit) => { return !described.includes(commit) })
      .map((commit) => { return {hash: commit.hash, reason: 'internal-only'} })
  })]
}

export {
  STALL
, describeEverything
, startFakeApi
, toolUse
}
