import {test} from 'tap'

import {createGenerateNotes} from '../../lib/generate-notes.js'
import {AudienceNotesError} from '../../lib/error.js'
import {resolve} from '../../lib/submission.js'

function makeContext(overrides = {}) {
  return {
    cwd: process.cwd()
  , env: {ANTHROPIC_API_KEY: 'test-key'}
  , logger: {log() {}, warn() {}, error() {}}
  , options: {repositoryUrl: 'https://github.com/mezmo/repo.git'}
  , lastRelease: {version: '1.0.0', gitTag: 'v1.0.0'}
  , nextRelease: {version: '1.1.0', gitTag: 'v1.1.0'}
  , commits: [
      {hash: 'aaa1111aaa', message: 'feat(core): add widget'}
    , {hash: 'bbb2222bbb', message: 'fix(core): stop leak'}
    ]
  , ...overrides
  }
}

// Stands in for the agent: describes every commit it is handed, one per entry.
function echoAgent(calls = []) {
  return {
    describe(payload) {
      calls.push(payload.map((commit) => { return commit.hash }))
      return {
        entries: payload.map((commit) => {
          return {
            hashes: [commit.hash]
          , section: commit.type === 'feat' ? 'features' : 'fixes'
          , scope: commit.scope
          , headline: commit.subject
          , details: []
          , importance: 'medium'
          , confidence: 'high'
          }
        })
      , omitted: []
      }
    }
  }
}

// The real agent resolves its submission before returning it, so the fakes do the
// same rather than every one of them being rewritten to speak commits.
function build(agent, deps = {}) {
  const resolving = {
    async describe(payload, context, logger) {
      return resolve(await agent.describe(payload, context, logger), payload)
    }
  }

  return createGenerateNotes({
    createAgent: () => { return resolving }
  , ...deps
  })
}

test('generateNotes() returns an empty string when there are no commits', async (t) => {
  const generateNotes = build(echoAgent())
  t.equal(await generateNotes({}, makeContext({commits: []})), '')
})

test('generateNotes() renders notes end to end', async (t) => {
  const generateNotes = build(echoAgent())
  const notes = await generateNotes({audience: 'operators'}, makeContext())

  const compare = 'https://github.com/mezmo/repo/compare/v1.0.0...v1.1.0'
  t.ok(notes.startsWith(`# [1.1.0](${compare}) (`))
  t.match(notes, '### Features\n\n* **core:** Add widget ([aaa1111](')
  t.match(notes, '### Bug Fixes\n\n* **core:** Stop leak ([bbb2222](')
})

test('generateNotes() renders a grouped entry once with both commit links', async (t) => {
  const context = makeContext({
    commits: [
      {hash: 'aaa1111aaa', message: 'feat(core): add widget'}
    , {hash: 'bbb2222bbb', message: 'feat(core): wire widget up'}
    ]
  })
  const grouping = {
    describe(payload) {
      return {
        summary: ''
      , entries: [{
          hashes: payload.map((commit) => { return commit.hash })
        , section: 'features'
        , scope: 'core'
        , headline: 'one change delivered across two commits'
        , details: []
        , importance: 'medium'
        , confidence: 'high'
        }]
      , omitted: []
      }
    }
  }

  const notes = await build(grouping)({}, context)
  const bullets = notes.split('\n').filter((line) => { return line.startsWith('* ') })
  t.equal(bullets.length, 1, 'two commits produced one line')
  t.match(bullets[0], /aaa1111/)
  t.match(bullets[0], /bbb2222/, 'both commits stay linkable')
})

test('generateNotes() honors a deliberate omission', async (t) => {
  const omitting = {
    describe(payload) {
      return {
        summary: ''
      , entries: [{
          hashes: [payload[0].hash]
        , section: 'features'
        , scope: 'core'
        , headline: 'the interesting one'
        , details: []
        , importance: 'medium'
        , confidence: 'high'
        }]
      , omitted: [{hash: payload[1].hash, reason: 'internal-only'}]
      }
    }
  }

  const warnings = []
  const context = makeContext()
  context.logger.warn = (message) => { warnings.push(message) }

  const notes = await build(omitting)({}, context)
  t.match(notes, /the interesting one/i)
  t.notMatch(notes, /stop leak/i, 'the omitted commit is gone')
  t.equal(warnings.length, 0, 'a deliberate omission is not warned about')
})

test('generateNotes() can surface omitted commits when asked', async (t) => {
  const omitting = {
    describe(payload) {
      return {
        summary: ''
      , entries: [{
          hashes: [payload[0].hash]
        , section: 'features'
        , scope: 'core'
        , headline: 'kept'
        , details: []
        , importance: 'medium'
        , confidence: 'high'
        }]
      , omitted: [{hash: payload[1].hash, reason: 'trivial'}]
      }
    }
  }

  const notes = await build(omitting)({includeOmitted: true}, makeContext())
  t.match(notes, /### Also in this release/)
  t.match(notes, /_\(trivial\)_/)
})

test('generateNotes() adds literal entries for skipped commits (strict)', async (t) => {
  const partial = {
    describe(payload) {
      return {
        summary: 'Partial.'
      , entries: [{
          hashes: [payload[0].hash]
        , section: 'features'
        , scope: 'core'
        , headline: 'Only the first one'
        , details: []
        , importance: 'medium'
        , confidence: 'high'
        }]
      , omitted: []
      }
    }
  }

  const errors = []
  const context = makeContext()
  context.logger.error = (message) => { errors.push(message) }

  const notes = await build(partial)({coverage: 'strict'}, context)
  t.match(notes, /Only the first one/)
  t.match(notes, /Stop leak/, 'the skipped commit still appears verbatim')
  // Rendering a commit from its subject is the plugin failing at the one thing it
  // exists for, so it is reported as a failure rather than a passing note.
  t.match(errors.join(' '), /1 commits as literal subjects/)
  t.match(errors.join(' '), /bbb2222/, 'and names which')
})

test('generateNotes() renders a commit the agent never described', async (t) => {
  const partial = {
    describe(payload) {
      return {
        summary: ''
      , entries: [{
          hashes: [payload[0].hash]
        , section: 'features'
        , scope: 'core'
        , headline: 'Only the first one'
        , details: []
        , importance: 'medium'
        , confidence: 'high'
        }]
      , omitted: []
      }
    }
  }

  const lines = []
  const context = makeContext()
  context.logger.error = (message) => { lines.push(message) }

  const notes = await build(partial)({}, context)
  t.match(notes, /Only the first one/)
  t.match(notes, /Stop leak/, 'the forgotten commit is rendered, never dropped')
  t.match(lines.join(' '), /never described them/, 'and reported as a failure')
})

test('generateNotes() runs with a context carrying no logger', async (t) => {
  // Exercises the no-op logger on both paths that write to it, the happy-path log
  // and the error raised when a forgotten commit has to be rendered.
  const context = makeContext()
  delete context.logger

  const partial = {
    describe(payload) {
      return {
        summary: ''
      , entries: [{
          hashes: [payload[0].hash]
        , section: 'features'
        , scope: 'core'
        , headline: 'kept'
        , details: []
        , importance: 'medium'
        , confidence: 'high'
        }]
      , omitted: []
      }
    }
  }

  const notes = await build(partial)({}, context)
  t.match(notes, /Kept/)
  t.match(notes, /Stop leak/, 'and the forgotten one still lands')
})

test('generateNotes() reports failure with no logger attached', async (t) => {
  const context = makeContext()
  delete context.logger

  const exploding = {describe() { throw new Error('agent exploded') }}
  await t.rejects(build(exploding)({}, context), /agent exploded/, 'and does not crash')
})

test('generateNotes() copes with a context that has no options', async (t) => {
  const context = makeContext()
  delete context.options

  const notes = await build(echoAgent())({}, context)
  t.match(notes, /Add widget/)
  t.notMatch(notes, /\]\(http/, 'no repository url means no links')
})

test('generateNotes() returns an empty string when every commit is', async (t) => {
  const notes = await build(echoAgent())({commitOpts: {ignore: '.'}}, makeContext())
  t.equal(notes, '', 'nothing survives the filter, so there are no notes')
})

test('generateNotes() uses the real agent factory when none is injected', async (t) => {
  // No API key, so it fails before reaching the network.
  const context = makeContext({env: {}})
  await t.rejects(createGenerateNotes()({}, context), {code: 'ENOAPIKEY'})
})

test('generateNotes() returns an empty string with no commits key', async (t) => {
  const context = makeContext()
  delete context.commits
  t.equal(await build(echoAgent())({}, context), '')
})

test('generateNotes() keeps a breaking change under lenient coverage', async (t) => {
  // "A breaking change is never omitted" does not have a coverage setting.
  const context = makeContext({commits: [
    {hash: 'aaa1111aaa', message: 'feat(api)!: drop the v1 endpoint'}
  , {hash: 'bbb2222bbb', message: 'fix(core): stop leak'}
  ]})
  const partial = {
    describe(payload) {
      return {
        entries: [{
          hashes: [payload[1].hash]
        , supporting: []
        , section: 'fixes'
        , scope: 'core'
        , headline: 'stop leak'
        , details: []
        , importance: 'medium'
        , confidence: 'high'
        }]
      , omitted: []
      }
    }
  }

  const notes = await build(partial)({coverage: 'lenient'}, context)
  t.match(notes, /Drop the v1 endpoint\./, 'the breaking change survives')
  t.match(notes, /Stop leak/)
})

test('generateNotes() says so when every commit was filtered out', async (t) => {
  const warnings = []
  const context = makeContext()
  context.logger.warn = (message) => { warnings.push(message) }

  const notes = await build(echoAgent())({commitOpts: {ignore: '.'}}, context)
  t.equal(notes, '')
  t.match(warnings.join(' '), /All 2 commits were filtered out/)
})

test('generateNotes() copes with no plugin config at all', async (t) => {
  const notes = await build(echoAgent())(undefined, makeContext())
  t.match(notes, /### Features/)
})

function dispositionAgent() {
  return {
    describe(payload) {
      return {
        entries: [{
          hashes: [payload[0].hash]
        , supporting: [payload[1].hash]
        , section: 'features'
        , headline: 'One change, two commits'
        , details: []
        , importance: 'medium'
        , confidence: 'high'
        }]
      , omitted: []
      }
    }
  }
}

test('generateNotes() names every disposition when verbose', async (t) => {
  const lines = []
  const context = makeContext()
  context.logger.log = (message) => { lines.push(message) }

  await build(dispositionAgent())({verbose: true}, context)

  t.match(lines.join('\n'), /supporting bbb2222 -> One change, two commits/)
})

test('generateNotes() names an omitted commit and its reason when verbose', async (t) => {
  const lines = []
  const context = makeContext()
  context.logger.log = (message) => { lines.push(message) }

  const omitting = {
    describe(payload) {
      return {
        entries: [{
          hashes: [payload[0].hash]
        , section: 'features'
        , headline: 'Kept'
        , details: []
        , importance: 'medium'
        , confidence: 'high'
        }]
      , omitted: [{hash: payload[1].hash, reason: 'no-audience-impact'}]
      }
    }
  }
  await build(omitting)({verbose: true}, context)

  t.match(lines.join('\n'), /omitted bbb2222 .*\(no-audience-impact\)/)
  t.notMatch(lines.join('\n'), /supporting/, 'an entry with none is skipped')
})

test('generateNotes() keeps the dispositions quiet by default', async (t) => {
  const lines = []
  const context = makeContext()
  context.logger.log = (message) => { lines.push(message) }

  await build(dispositionAgent())({}, context)

  t.notMatch(lines.join('\n'), /supporting/)
  t.match(lines.join('\n'), /Wrote 1 entries/, 'the summary line still lands')
})

test('generateNotes() names an entry the rails deleted when verbose', async (t) => {
  // The commit stays accounted for, so this is never an error. It is prose the
  // agent wrote that no reader ever sees, which was invisible until it was named.
  const lines = []
  const context = makeContext()
  context.logger.log = (message) => { lines.push(message) }

  const dropping = {
    describe(payload) {
      const first = payload[0].hash
      function row(over) {
        return {
          hashes: [first]
        , section: 'features'
        , details: []
        , importance: 'medium'
        , confidence: 'high'
        , ...over
        }
      }
      return {
        entries: [
          // Claims both, so no unclaimed commit brings a stub entry along with it.
          row({hashes: payload.map((c) => { return c.hash }), headline: 'Kept'})
        , row({headline: 'Deleted by the rail'})
        , row({hashes: [], headline: 'Named no commits'})
        ]
      , omitted: []
      }
    }
  }
  await build(dropping)({verbose: true}, context)

  const log = lines.join('\n')
  t.match(log, /dropped \w+ \(commits-already-claimed\) -> Deleted by the rail/)
  t.match(log, /dropped \(none\) \(no-commits\) -> Named no commits/)
  t.match(log, /Wrote 1 entries/, 'and only the survivor is counted')
})

test('generateNotes() stops the release when the agent fails', async (t) => {
  // There is no degrade mode. Notes are written once and a green pipeline goes
  // unread, so a run that cannot produce them has to fail loudly.
  const exploding = {describe() { throw new Error('agent exploded') }}
  await t.rejects(build(exploding)({}, makeContext()), /agent exploded/)
})

test('generateNotes() reports an SDK failure as a plugin error', async (t) => {
  // semantic-release renders a code, a message and details only for an error
  // carrying its flag, and dumps the raw object twice for anything else. An SDK
  // error arrived as sixty lines of undefined fields.
  const boom = new Error('Failed to resolve AWS credentials')
  boom.name = 'APIConnectionError'
  const exploding = {describe() { throw boom }}

  await t.rejects(build(exploding)({}, makeContext()), {
    name: 'SemanticReleaseError'
  , code: 'EAGENTFAILED'
  , semanticRelease: true
  })

  const err = await build(exploding)({}, makeContext()).catch((e) => { return e })
  t.match(err.message, /Failed to resolve AWS credentials/, 'the cause is not buried')
  t.equal(err.cause, boom, 'and the original survives for a stack trace')
})

test('generateNotes() leaves an error that already carries the contract', async (t) => {
  // Wrapping one of ours would bury the code that names the actual problem.
  const mine = new AudienceNotesError('ETIMEOUT', 'The agent ran out of time.')
  const exploding = {describe() { throw mine }}

  const err = await build(exploding)({}, makeContext()).catch((e) => { return e })
  t.equal(err, mine, 're-thrown as-is')
  t.equal(err.code, 'ETIMEOUT', 'not re-coded as a generic agent failure')
})

test('generateNotes() stops the release when no api key is set', async (t) => {
  await t.rejects(
    build(echoAgent())({}, makeContext({env: {}}))
  , {code: 'ENOAPIKEY'}
  )
})

test('generateNotes() stops the release when the config is bad', async (t) => {
  // A bad regex throws from the RegExp constructor, not as one of our coded errors,
  // and it used to be swallowed into a conventional changelog.
  await t.rejects(
    build(echoAgent())({commitOpts: {ignore: 'chore(deps'}}, makeContext())
  , /Unterminated group/
  )
})

test('generateNotes() warns about a fully filtered release with no logger', async (t) => {
  // The last of the three no-op logger stubs. A lenient drop used to be what
  // reached warn on this path; filtering every commit out is what reaches it now.
  const context = makeContext()
  delete context.logger

  t.equal(await build(echoAgent())({commitOpts: {ignore: '.'}}, context), '')
})

test('generateNotes() lists a forgotten commit the table has no home for', async (t) => {
  const context = makeContext({commits: [
    {hash: 'aaa1111aaa', message: 'feat(core): add widget'}
  , {hash: 'ccc3333ccc', message: 'chore(deps): bump'}
  ]})
  const errors = []
  context.logger.error = (message) => { errors.push(message) }

  const partial = {
    describe(payload) {
      return {
        entries: [{
          hashes: [payload[0].hash]
        , section: 'features'
        , scope: 'core'
        , headline: 'add widget'
        , details: []
        , importance: 'medium'
        , confidence: 'high'
        }]
      , omitted: []
      }
    }
  }

  const notes = await build(partial)({includeOmitted: true}, context)
  const listed = /^\* Bump \(\[ccc3333\]\(.+\)\) _\(internal-only\)_$/m
  t.match(notes, listed, 'listed as omitted rather than rendered')
  t.match(errors.join(' '), /ccc3333/, 'and still reported as a failure')
})

