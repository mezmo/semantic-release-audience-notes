import Anthropic from '@anthropic-ai/sdk'

import {AudienceNotesError} from './error.js'
import {buildSystem, buildKickoff} from './prompt.js'
import {createSession, createTools} from './tools.js'
import {createRecorder, formatRecord} from './debug.js'
import {createUsage} from './usage.js'

const MAX_MESSAGE_CACHE_POINTS = 2
const CACHEABLE_BLOCKS = new Set(['text', 'tool_use', 'tool_result', 'image', 'document'])

// Runs the navigation loop. The agent reads what it judges worth reading and
// ends by calling submit_release_notes, whose input schema is the result
// contract — so the run terminates in a shape-guaranteed payload rather than in
// prose that has to be parsed.
// Bedrock authenticates through the AWS credential chain and its SDK is an
// optional dependency, so it is loaded only when actually selected.
async function createClient(options, deps = {}) {
  const shared = {
    maxRetries: options.maxRetries
    // The SDK's timeout ends when a response starts. settle() bounds the stream
    // after that with the same value.
  , timeout: options.timeout
  , ...(options.baseUrl ? {baseURL: options.baseUrl} : {})
  }

  if (options.provider !== 'bedrock') {
    return new Anthropic({apiKey: options.apiKey, ...shared})
  }

  const load = deps.importBedrock || (() => {
    return import('@anthropic-ai/bedrock-sdk')
  })

  let bedrock
  try {
    bedrock = await load()
  } catch {
    throw new AudienceNotesError(
      'ENOBEDROCKSDK'
    , 'The `bedrock` provider needs the @anthropic-ai/bedrock-sdk package.'
    , 'Install it: npm install @anthropic-ai/bedrock-sdk'
    )
  }

  return new bedrock.AnthropicBedrockMantle({awsRegion: options.region, ...shared})
}

function createAgent(options, deps = {}) {
  const clientFor = deps.createClient || createClient

  return {
    async describe(payload, context, logger) {
      const anthropic = await clientFor(options)
      const budget = options.agent.maxToolCalls
      const onRecord = options.verbose
        ? (type, data) => { logger.log(formatRecord(type, data)) }
        : null
      const recorder = createRecorder(onRecord)
      const kickoff = buildKickoff(payload, context, options)
      const session = createSession(payload, options, {
        ...context
      , recorder
      , listingTruncated: kickoff.truncated
      , onProblem: (message) => { logger.error(message) }
      , onCall: ({name, detail, index}) => {
          logger.log(`  [${index}/${budget}] ${name}${detail ? ` ${detail}` : ''}`)
        }
      })

      logger.log(
        `Investigating ${payload.length} commits with ${options.model}`
          + ` (up to ${budget} tool calls)`
      )
      const system = buildSystem(options)

      recorder.record('run', {
        model: options.model
      , provider: options.provider
      , effort: options.effort
      , audience: options.audience.name
      , commits: payload.length
      , budget
      })
      recorder.record('system', {prompt: system})
      recorder.record('kickoff', {prompt: kickoff.prompt})

      const runner = anthropic.beta.messages.toolRunner({
        model: options.model
      , max_tokens: options.agent.maxTokens
      , thinking: {type: 'adaptive'}
      , output_config: {effort: options.effort}
      , system: [
          {
            type: 'text'
          , text: system
          , ...(options.promptCaching ? {cache_control: {type: 'ephemeral'}} : {})
          }
        ]
      , tools: createTools(session)
      , messages: [{
          role: 'user'
        , content: [{
            type: 'text'
          , text: kickoff.prompt
          , ...(options.promptCaching ? {cache_control: {type: 'ephemeral'}} : {})
          }]
        }]
      , max_iterations: options.agent.maxIterations
        // A turn at the higher efforts can outlast the ten minutes the API allows
        // a request that does not stream.
      , stream: true
      })

      const usage = createUsage()
      let last = null

      let turn = 0
      try {
        for await (const stream of runner) {
          const message = await settle(stream, options.timeout)
          last = message
          usage.add(message)
          recorder.record('turn', {
            index: ++turn
          , stop_reason: message.stop_reason
          , usage: message.usage
            // What the model said, as opposed to what it called. A turn that ends
            // without submitting has its reason here and nowhere else.
          , text: textOf(message)
          })

          // The runner yields a turn before executing that turn's tools, so the
          // submission would otherwise be a turn behind and every run would pay one
          // more full-conversation request. The runner memoises this per turn, so
          // the tools still run once.
          //
          // Only a turn that stopped to call tools runs them. A max_tokens turn can
          // hold a submission cut off mid-argument, and the runner itself stops on
          // that reason rather than executing it; it resumes a pause_turn itself.
          const results = message.stop_reason === 'tool_use'
            ? await runner.generateToolResponse()
            : null
          if (options.promptCaching) {
            markCachePoint(runner.params.messages, results || message)
          }

          // Coverage is judged by the submit tool itself, which answers an
          // incomplete attempt in its own tool result. Nothing is left to ask here.
          if (session.submission) break
        }
      } catch (err) {
        // A submission already in hand survives whatever the run does next.
        if (!session.best) throw err
        logger.warn(`Agent stopped after submitting: ${err.message}`)
      }

      // The runner yields a turn before executing that turn's tools, so a
      // submission made on the last allowed iteration, or on the turn a failure
      // interrupted, lands after the loop rather than inside it.
      const best = session.best

      recorder.record('finished', {
        turns: turn
      , calls: session.calls
      , usage: usage.totals
      , stop_reason: last && last.stop_reason
      })
      logger.log(`Agent made ${session.calls} tool calls (${summarizeCalls(session.log)})`)
      logger.log(`Token usage: ${usage.format()}`)

      if (!best) {
        const reason = last && last.stop_reason
        throw new AudienceNotesError(
          'ENOSUBMISSION'
        , 'The agent finished without calling submit_release_notes'
            + `${reason ? ` (stop reason: ${reason})` : ''}.`
        , reason === 'max_tokens'
            ? 'A turn ran out of output tokens. Raise `agent.maxTokens`'
              + ' or lower `effort`.'
            : 'Raise `agent.maxIterations` or `agent.maxToolCalls`.'
        )
      }

      return best.resolved
    }
  }
}

// A stream that goes quiet after it connects would otherwise hold the release open
// indefinitely, because the SDK's timeout stops once the response starts. Every
// event restarts the clock.
async function settle(stream, ms) {
  let timer = null
  let quiet = false
  function arm() {
    clearTimeout(timer)
    timer = setTimeout(() => {
      quiet = true
      stream.abort()
    }, ms)
  }
  stream.on('connect', arm)
  stream.on('streamEvent', arm)
  try {
    return await stream.finalMessage().catch((err) => {
      if (!quiet) throw err
      throw new AudienceNotesError(
        'ESTREAMSTALLED'
      , `The model's response sent nothing for ${ms} ms, so the run gave up.`
      , 'Run it again, or raise `timeout`.'
      )
    })
  } finally {
    clearTimeout(timer)
    stream.off('connect', arm)
    stream.off('streamEvent', arm)
  }
}

function textOf(message) {
  return (message.content || []).filter((block) => {
    return block.type === 'text'
  }).map((block) => {
    return block.text
  }).join('\n')
}

// Every turn resends the entire conversation, so the cache point moves to its end.
// Each request writes the prefix through that point once, and the next reads it.
//
// The runner adds a turn's tool results only after the loop body returns, so the
// last message it holds is a turn old. The point goes on `newest`, the message it
// is about to add. That is the object the runner pushes, because
// generateToolResponse() is memoised and a paused turn is pushed with this
// message's own content.
//
// Deliberately not runner.setMessagesParams(): that marks the params mutated, and
// the runner then skips pushing the assistant message on the assumption the
// caller supplied it, which quietly drops a turn out of the conversation.
function markCachePoint(messages, newest) {
  // Only blocks whose schema carries the field. A thinking block's does not, and
  // a paused turn can end in one.
  const block = [...newest.content].reverse().find((candidate) => {
    return CACHEABLE_BLOCKS.has(candidate.type)
  })
  if (!block) return
  block.cache_control = {type: 'ephemeral'}

  // The request caps how many breakpoints it accepts, and the system block holds
  // one. Keeping the previous point as well as the newest means a prefix that
  // stopped matching at the newest can still be read from the one before it.
  const marked = [...messages, newest].flatMap((message) => {
    return message.content.filter((candidate) => {
      return candidate.cache_control
    })
  })
  while (marked.length > MAX_MESSAGE_CACHE_POINTS) delete marked.shift().cache_control
}

function summarizeCalls(log) {
  const counts = new Map()
  for (const name of log) {
    counts.set(name, (counts.get(name) || 0) + 1)
  }
  return [...counts.entries()].map(([name, count]) => {
    return `${name}×${count}`
  }).join(', ') || 'none'
}

export {
  createAgent
, createClient
, summarizeCalls
}
