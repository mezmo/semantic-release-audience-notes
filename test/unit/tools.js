import {test} from 'tap'

import {createSession, createTools, safeRelative, spend} from '../../lib/tools.js'
import {normalize} from '../../lib/options.js'

// `internal` sets the agent's fixed bounds, which are not options, so a test can
// reach a cap without a payload the size of the real one.
function makeSession(overrides = {}) {
  const options = normalize(overrides.config || {}, {env: {}})
  Object.assign(options.agent, overrides.internal)
  const payload = overrides.payload || [{
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
  return createSession(payload, options, {cwd: '/tmp/repo', ...overrides.context})
}

function toolsByName(session) {
  return new Map(createTools(session).map((tool) => {
    return [tool.name, tool]
  }))
}

test('createTools() exposes the read surface plus a terminal submit tool', async (t) => {
  t.same(
    [...toolsByName(makeSession()).keys()]
  , [
      'read_commit', 'read_diff', 'read_file'
    , 'grep', 'submit_release_notes'
    ]
  )
})

test('read_commit and read_diff reject a hash outside the release', async (t) => {
  const tools = toolsByName(makeSession())
  t.match(await tools.get('read_commit').run({hash: 'zzz9999'}), /No commit zzz9999/)
  const diff = await tools.get('read_diff').run({hash: 'zzz9999', path: ''})
  t.match(diff, /No commit zzz9999/)
})

test('submit_release_notes records the payload and halts the agent', async (t) => {
  const session = makeSession()
  const submission = {
    summary: 's'
  , entries: [{hashes: ['aaa1111'], section: 'features', headline: 'It'}]
  , omitted: []
  }

  const out = await toolsByName(session).get('submit_release_notes').run(submission)

  t.ok(session.submission, 'the result is captured out of band')
  t.same(
    session.submission.entries[0].commits.map((commit) => { return commit.hash })
  , ['aaa1111']
  , 'already resolved, so nothing downstream handles a hash'
  )
  t.match(out, /Stop now/)
})

test('submit_release_notes answers an unknown hash with no handler', async (t) => {
  // The plugin always passes onProblem. Without one the session falls back to a
  // no-op, so an unresolved hash is still answered rather than thrown on.
  const session = makeSession()
  const submission = {
    entries: [{hashes: ['zzz9999'], section: 'features', headline: 'It'}]
  , omitted: []
  }

  const out = await toolsByName(session).get('submit_release_notes').run(submission)

  t.match(out, /Not recorded/, 'the commit it should have named is still missing')
})

test('submit_release_notes carries the result schema as its input schema', async (t) => {
  const tool = createTools(makeSession()).find((entry) => {
    return entry.name === 'submit_release_notes'
  })
  const schema = tool.input_schema
  t.ok(schema, 'the tool exposes an input schema')
  t.same(Object.keys(schema.properties).sort(), ['entries', 'omitted'])
})

test('spend() reports budget exhaustion instead of throwing', async (t) => {
  const session = makeSession({config: {agent: {maxToolCalls: 2}}})

  t.equal(spend(session, 'a'), null)
  t.equal(spend(session, 'b'), null)
  const over = spend(session, 'c')
  t.match(over, /budget of 2 is exhausted/)
  t.match(over, /submit_release_notes/, 'it tells the agent how to finish')
})

test('read tools refuse to run once the budget is spent', async (t) => {
  const session = makeSession({config: {agent: {maxToolCalls: 1}}})
  const tools = toolsByName(session)

  await tools.get('read_diff').run({hash: 'aaa1111', path: ''})
  const out = await tools.get('read_commit').run({hash: 'aaa1111'})
  t.match(out, /budget of 1 is exhausted/)
})

test('safeRelative() confines model-supplied paths to the repository', async (t) => {
  const session = makeSession()

  t.equal(safeRelative(session, 'lib/a.js'), 'lib/a.js')
  t.equal(safeRelative(session, './lib/../lib/a.js'), 'lib/a.js')
  t.equal(safeRelative(session, '../../etc/passwd'), null, 'traversal is refused')
  t.equal(safeRelative(session, '/etc/passwd'), null, 'absolute escape is refused')
  t.equal(safeRelative(session, ''), null)
})

test('read_file refuses a path outside the repository', async (t) => {
  const tools = toolsByName(makeSession())
  const out = await tools.get('read_file').run({path: '../../etc/passwd'})
  t.match(out, /outside the repository/)
})

test('createSession() pins the ref to the release head when available', async (t) => {
  const pinned = makeSession({context: {nextRelease: {gitHead: 'abc123'}}})
  t.equal(pinned.ref, 'abc123')
  t.equal(makeSession().ref, 'HEAD', 'falls back to HEAD')
})

test('submit_release_notes is never refused for budget reasons', async (t) => {
  const session = makeSession({config: {agent: {maxToolCalls: 1}}})
  const tools = toolsByName(session)

  await tools.get('read_diff').run({hash: 'aaa1111', path: ''})
  t.match(await tools.get('read_commit').run({hash: 'aaa1111'}), /exhausted/)

  const submission = {
    summary: 's'
  , entries: []
  , omitted: [{hash: 'aaa1111', reason: 'trivial'}]
  }
  await tools.get('submit_release_notes').run(submission)
  t.ok(
    session.submission
  , 'an agent told to submit because it ran out of budget can still submit'
  )
})

test('createSession() falls back to the process cwd', async (t) => {
  const session = createSession([], normalize({}, {env: {}}), undefined)
  t.equal(session.cwd, process.cwd())
})

test('read_commit rejects a missing hash argument', async (t) => {
  const out = await toolsByName(makeSession()).get('read_commit').run({hash: undefined})
  t.match(out, /No commit/)
})

test('read_diff refuses once the budget is spent', async (t) => {
  const session = makeSession({config: {agent: {maxToolCalls: 1}}})
  const tools = toolsByName(session)

  await tools.get('read_commit').run({hash: 'aaa1111'})
  const out = await tools.get('read_diff').run({hash: 'aaa1111', path: ''})
  t.match(out, /exhausted/)
})

test('recorded() puts a failed tool call on the transcript', async (t) => {
  // The crashing call is the one worth having, and it was the one omitted.
  const records = []
  const session = makeSession()
  session.recorder = {file: '', record: (type, data) => { records.push([type, data]) }}

  const tool = createTools(session).find((entry) => {
    return entry.name === 'read_commit'
  })
  session.commits = null

  await t.rejects(tool.run({hash: 'aaa1111'}))
  t.equal(records.length, 1, 'the call is recorded even though it threw')
  t.equal(records[0][1].name, 'read_commit')
  t.ok(records[0][1].error, 'with the failure on it')
})

test('read_diff reports a git failure as a tool result', async (t) => {
  // A shallow clone makes this routine in CI. Raw stderr carries the absolute
  // repository path into the model's context.
  const session = makeSession()
  session.cwd = '/nonexistent-repo-path'
  const out = await toolsByName(session).get('read_diff').run({hash: 'aaa1111', path: ''})

  t.match(out, /Could not read that diff/)
  t.notMatch(out, /nonexistent-repo-path/, 'and does not leak the path')
})

test('read_commit survives a repository git cannot read', async (t) => {
  const session = makeSession()
  session.cwd = '/nonexistent-repo-path'
  const out = await toolsByName(session).get('read_commit').run({hash: 'aaa1111'})

  t.match(out, /aaa1111/, 'the message is still reported')
  t.notMatch(out, /nonexistent-repo-path/, 'with no file list and no leaked path')
})

test('grep tells a broken search apart from an empty one', async (t) => {
  // git grep exits 1 on a genuine miss and 128 on a bad pattern. Calling both "no
  // matches" tells the model a symbol has no call sites when the search never ran.
  const session = makeSession()
  session.cwd = '/nonexistent-repo-path'
  const out = await toolsByName(session).get('grep').run({pattern: 'x', glob: ''})

  t.match(out, /could not run/)
  t.notMatch(out, /No matches/)
})

test('read_commit caps a commit body that runs long', async (t) => {
  // The one read tool with no cap. A squash-merge body runs to hundreds of
  // kilobytes, and every later turn re-sends it.
  const payload = [{
    hash: 'aaa1111', fullHash: 'aaa1111000', subject: 'squash', type: 'feat'
  , scope: 'core', breaking: false, references: [], breakingNotes: []
  , body: 'z'.repeat(80000)
  }]
  const session = makeSession({
    payload
  , internal: {maxToolResultBytes: 2048}
  , context: {listingTruncated: true}
  })

  const out = await toolsByName(session).get('read_commit').run({hash: 'aaa1111'})
  t.match(out, /commit truncated/)
  t.ok(Buffer.byteLength(out) < 4096, `bounded (${Buffer.byteLength(out)} bytes)`)
})

test('submit_release_notes asks again in its own tool result', async (t) => {
  // Asking through a pushed message costs a request that went out before the
  // question, and the runner drops the turn that message interrupts.
  const session = makeSession({payload: [
    {hash: 'aaa1111', fullHash: 'a1', subject: 'one', type: 'feat', scope: ''
    , breaking: false, references: [], breakingNotes: [], body: ''}
  , {hash: 'bbb2222', fullHash: 'b2', subject: 'two', type: 'fix', scope: ''
    , breaking: false, references: [], breakingNotes: [], body: ''}
  ]})
  const submit = toolsByName(session).get('submit_release_notes')
  const partial = {
    entries: [{hashes: ['aaa1111'], supporting: [], section: 'features', headline: 'One'}]
  , omitted: []
  }

  const asked = await submit.run(partial)
  t.match(asked, /Not recorded/)
  t.match(asked, /bbb2222/, 'and names what is missing')
  t.equal(session.submission, null, 'nothing is recorded yet')

  const complete = {
    entries: partial.entries
  , omitted: [{hash: 'bbb2222', reason: 'trivial'}]
  }
  t.match(await submit.run(complete), /Stop now/)
  t.ok(session.submission, 'the fuller answer lands')
})

test('submit_release_notes gives up asking and keeps the best attempt', async (t) => {
  const session = makeSession({
    payload: [
      {hash: 'aaa1111', fullHash: 'a1', subject: 'one', type: 'feat', scope: ''
      , breaking: false, references: [], breakingNotes: [], body: ''}
    , {hash: 'bbb2222', fullHash: 'b2', subject: 'two', type: 'fix', scope: ''
      , breaking: false, references: [], breakingNotes: [], body: ''}
    ]
  , internal: {maxSubmissionRetries: 1}
  })
  const submit = toolsByName(session).get('submit_release_notes')
  const partial = {
    entries: [{hashes: ['aaa1111'], supporting: [], section: 'features', headline: 'One'}]
  , omitted: []
  }

  t.match(await submit.run(partial), /Not recorded/)
  t.match(await submit.run({entries: [], omitted: []}), /Stop now/, 'the budget is spent')
  t.equal(
    session.submission.entries.length
  , 1
  , 'and the fuller of the two attempts is what is kept'
  )
})

test('read_file refuses a path the excludes cover', async (t) => {
  // `git show <ref>:<path>` takes no pathspec, so the exclude list is checked here
  // rather than in the argv the way every other read tool does it.
  const session = makeSession()
  const out = await toolsByName(session).get('read_file').run({path: 'package-lock.json'})

  t.match(out, /excluded from the files this release exposes/)
})

test('read_file refuses a path under a directory the excludes name', async (t) => {
  // Git reads a pattern that matches a directory as excluding all of it, so
  // read_file has to agree with the pathspecs read_diff and grep pass.
  const session = makeSession({config: {introspect: {exclude: ['vendor', 'gen/']}}})
  const readFile = toolsByName(session).get('read_file')

  t.match(await readFile.run({path: 'vendor/lib/x.js'}), /excluded/)
  t.match(await readFile.run({path: 'gen/types.d.ts'}), /excluded/)
  t.match(await readFile.run({path: 'vendor'}), /excluded/, 'and the directory itself')
})

test('submit_release_notes says why an entry it dropped does not count', async (t) => {
  const session = makeSession({payload: [
    {hash: 'aaa1111', fullHash: 'a1', subject: 'one', type: 'feat', scope: ''
    , breaking: false, references: [], breakingNotes: [], body: ''}
  , {hash: 'bbb2222', fullHash: 'b2', subject: 'two', type: 'fix', scope: ''
    , breaking: false, references: [], breakingNotes: [], body: ''}
  ]})
  const submit = toolsByName(session).get('submit_release_notes')

  const asked = await submit.run({
    entries: [
      {hashes: ['aaa1111'], supporting: [], section: 'features', headline: 'One'}
    , {hashes: ['aaa1111'], supporting: ['bbb2222'], section: 'fixes', headline: 'Two'}
    ]
  , omitted: []
  })

  t.match(asked, /Not recorded[^]*bbb2222/)
  t.match(
    asked
  , /- "Two\." \(aaa1111, bbb2222\), dropped because every commit it named is already on/
  )
  t.notMatch(asked, /"One/, 'an entry that counts is not listed')
})
