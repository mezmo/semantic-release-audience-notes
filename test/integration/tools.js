import {execFile} from 'node:child_process'
import {mkdtemp, rm, writeFile, mkdir} from 'node:fs/promises'
import {promisify} from 'node:util'
import {tmpdir} from 'node:os'
import path from 'node:path'

import {test} from 'tap'

import {createSession, createTools} from '../../lib/tools.js'
import {isGitRepository} from '../../lib/git.js'
import {normalize} from '../../lib/options.js'
import {signCommits} from '../fixtures/signed.js'

const run = promisify(execFile)

async function makeRepo(t) {
  const cwd = await mkdtemp(path.join(tmpdir(), 'audience-notes-'))
  t.teardown(() => { return rm(cwd, {recursive: true, force: true}) })

  await run('git', ['init', '--quiet', '-b', 'main'], {cwd})
  await run('git', ['config', 'user.email', 'test@example.com'], {cwd})
  await run('git', ['config', 'user.name', 'Test'], {cwd})
  return cwd
}

async function commit(cwd, files, message) {
  for (const [name, contents] of Object.entries(files)) {
    const target = path.join(cwd, name)
    await mkdir(path.dirname(target), {recursive: true})
    await writeFile(target, contents)
  }
  await run('git', ['add', '-A'], {cwd})
  await run('git', ['commit', '--quiet', '-m', message], {cwd})
  const {stdout} = await run('git', ['rev-parse', 'HEAD'], {cwd})
  return stdout.trim()
}

function payloadFor(hash, overrides = {}) {
  return {
    hash: hash.slice(0, 7)
  , fullHash: hash
  , subject: 'change something'
  , type: 'fix'
  , scope: 'core'
  , breaking: false
  , references: []
  , breakingNotes: []
  , body: ''
  , ...overrides
  }
}

// `agent` is assigned over the normalized agent bounds, internal ones included.
function toolsFor(cwd, payload, agent = {}) {
  const options = normalize({}, {env: {}})
  Object.assign(options.agent, agent)
  const session = createSession(payload, options, {cwd})
  const tools = new Map(createTools(session).map((tool) => {
    return [tool.name, tool]
  }))
  return {session, tools}
}

test('isGitRepository() distinguishes a repo from a plain directory', async (t) => {
  t.ok(await isGitRepository(await makeRepo(t)))
  t.notOk(await isGitRepository(tmpdir()))
})

test('read_commit reports real per-file churn', async (t) => {
  const cwd = await makeRepo(t)
  await commit(cwd, {'a.js': 'const a = 1\n'}, 'feat: add a')
  const hash = await commit(
    cwd
  , {'a.js': 'const a = 2\nconst b = 3\n', 'b.js': 'const c = 4\n'}
  , 'feat: change a and add b'
  )

  const {tools} = toolsFor(cwd, [payloadFor(hash)])
  const out = await tools.get('read_commit').run({hash: hash.slice(0, 7)})

  t.match(out, /files changed \(\+3 -1\)/, '2 lines in a.js plus 1 in b.js')
  t.match(out, /a\.js \+2 -1/)
  t.match(out, /b\.js \+1 -0/)
})

test('read_diff returns a real patch and can scope to one file', async (t) => {
  const cwd = await makeRepo(t)
  await commit(cwd, {'a.js': '1\n', 'b.js': '1\n'}, 'chore: seed')
  const hash = await commit(cwd, {'a.js': '2\n', 'b.js': '2\n'}, 'fix: bump both')

  const {tools} = toolsFor(cwd, [payloadFor(hash)])
  const all = await tools.get('read_diff').run({hash: hash.slice(0, 7), path: ''})
  t.match(all, /a\.js/)
  t.match(all, /b\.js/)

  const scoped = await tools.get('read_diff').run({hash: hash.slice(0, 7), path: 'a.js'})
  t.match(scoped, /a\.js/)
  t.notMatch(scoped, /b\.js/, 'scoping keeps the other file out of context')
})

test('read_diff names paths from the package it runs in', async (t) => {
  // read_file and grep take paths relative to the cwd, so the patch has to name
  // them the same way for a path in it to be one the agent can open.
  const cwd = await makeRepo(t)
  function files(value) {
    return {'packages/app/src/a.js': value, 'packages/other/b.js': value}
  }
  await commit(cwd, files('1\n'), 'chore: seed')
  const hash = await commit(cwd, files('2\n'), 'fix: bump both')

  const {tools} = toolsFor(path.join(cwd, 'packages', 'app'), [payloadFor(hash)])
  const out = await tools.get('read_diff').run({hash: hash.slice(0, 7), path: ''})
  t.match(out, /\+\+\+ b\/src\/a\.js/)
  t.notMatch(out, /packages\//, 'no path is spelled from the repository root')
  t.notMatch(out, /b\.js/, 'and the other package stays out')

  const opened = await tools.get('read_file').run({path: 'src/a.js'})
  t.match(opened, /2/, 'a path from the patch opens as written')
})

test('read_diff excludes lockfiles at the repo root', async (t) => {
  const cwd = await makeRepo(t)
  await commit(cwd, {'seed.js': '0\n'}, 'chore: seed')
  const hash = await commit(cwd, {
    'keep.js': 'const a = 1\n'
  , 'package-lock.json': '{"lockfileVersion": 3}\n'
  }, 'chore: lockfile at root')

  const {tools} = toolsFor(cwd, [payloadFor(hash)])
  const out = await tools.get('read_diff').run({hash: hash.slice(0, 7), path: ''})

  t.match(out, /keep\.js/)
  t.notMatch(out, /package-lock/, 'glob exclude matches at the root, not only nested')
})

test('read_diff truncates a patch that exceeds the per-call cap', async (t) => {
  const cwd = await makeRepo(t)
  await commit(cwd, {'seed.js': '0\n'}, 'chore: seed')
  const big = Array.from({length: 400}, (unused, index) => { return `line ${index}` }).join('\n')
  const hash = await commit(cwd, {'big.txt': `${big}\n`}, 'chore: big file')

  const {tools} = toolsFor(cwd, [payloadFor(hash)], {maxToolResultBytes: 512})
  const out = await tools.get('read_diff').run({hash: hash.slice(0, 7), path: ''})

  t.match(out, /patch truncated/)
  t.ok(Buffer.byteLength(out, 'utf8') < 700, 'the cap bounds what reaches the context')
})

test('read_file reads at the release ref and refuses escapes', async (t) => {
  const cwd = await makeRepo(t)
  const hash = await commit(cwd, {'lib/a.js': 'export const a = 1\n'}, 'feat: a')

  const {tools} = toolsFor(cwd, [payloadFor(hash)])
  t.match(await tools.get('read_file').run({path: 'lib/a.js'}), /export const a = 1/)
  t.match(await tools.get('read_file').run({path: 'nope.js'}), /No file at nope\.js/)
  t.match(
    await tools.get('read_file').run({path: '../../etc/passwd'})
  , /outside the repository/
  )
})

test('grep finds matches and reports none cleanly', async (t) => {
  const cwd = await makeRepo(t)
  const hash = await commit(
    cwd
  , {'lib/a.js': 'export function widget() {}\n', 'lib/b.js': 'const x = 1\n'}
  , 'feat: widget'
  )

  const {tools} = toolsFor(cwd, [payloadFor(hash)])
  const hits = await tools.get('grep').run({pattern: 'widget', glob: ''})
  t.match(hits, /lib\/a\.js/)

  t.equal(await tools.get('grep').run({pattern: 'nothinghere', glob: ''}), 'No matches.')
})

test('grep can be scoped by glob', async (t) => {
  const cwd = await makeRepo(t)
  const hash = await commit(
    cwd
  , {'lib/a.js': 'needle\n', 'test/a.js': 'needle\n'}
  , 'feat: needles'
  )

  const {tools} = toolsFor(cwd, [payloadFor(hash)])
  const scoped = await tools.get('grep').run({pattern: 'needle', glob: 'lib/**'})
  t.match(scoped, /lib\/a\.js/)
  t.notMatch(scoped, /test\/a\.js/)
})

test('a shell metacharacter in a grep pattern is not executed', async (t) => {
  const cwd = await makeRepo(t)
  const hash = await commit(cwd, {'a.js': 'safe\n'}, 'feat: a')

  const {tools} = toolsFor(cwd, [payloadFor(hash)])
  // Passed through execFile as one argv entry, never a shell string.
  const out = await tools.get('grep').run({pattern: 'safe; touch pwned', glob: ''})
  t.equal(out, 'No matches.')
  await t.rejects(run('git', ['show', `${hash}:pwned`], {cwd}), 'no file was created')
})

test('the tool-call budget is shared across every read tool', async (t) => {
  const cwd = await makeRepo(t)
  const hash = await commit(cwd, {'a.js': '1\n'}, 'feat: a')

  const {session, tools} = toolsFor(cwd, [payloadFor(hash)], {maxToolCalls: 2})
  await tools.get('read_diff').run({hash: hash.slice(0, 7), path: ''})
  await tools.get('read_commit').run({hash: hash.slice(0, 7)})

  t.match(await tools.get('grep').run({pattern: 'a', glob: ''}), /exhausted/)
  t.match(await tools.get('read_file').run({path: 'a.js'}), /exhausted/)
  t.equal(session.calls, 4, 'refused calls still count, so the agent cannot loop forever')
})

test('read_diff reports a commit whose files are all excluded', async (t) => {
  const cwd = await makeRepo(t)
  await commit(cwd, {'seed.js': '0\n'}, 'chore: seed')
  const files = {'package-lock.json': '{"v": 1}\n'}
  const hash = await commit(cwd, files, 'chore: lockfile only')

  const {tools} = toolsFor(cwd, [payloadFor(hash)])
  const out = await tools.get('read_diff').run({hash: hash.slice(0, 7), path: ''})

  t.match(out, /no readable diff/, 'an empty patch is explained, not returned blank')
})

test('read_commit and read_diff leave out signature checks', async (t) => {
  // With log.showSignature on, git prints "Good signature" ahead of every show.
  const cwd = await makeRepo(t)
  await commit(cwd, {'a.js': '1\n'}, 'chore: seed')
  if (!await signCommits(cwd)) return t.skip('ssh-keygen is not installed')
  const hash = await commit(cwd, {'a.js': '2\n'}, 'fix: signed change')
  const {stdout} = await run('git', ['show', '--format=', '--stat', hash], {cwd})
  t.match(stdout, /signature/i, 'git does print the check here')

  const {tools} = toolsFor(cwd, [payloadFor(hash)])
  const short = hash.slice(0, 7)
  t.notMatch(await tools.get('read_commit').run({hash: short}), /signature/i)
  t.notMatch(await tools.get('read_diff').run({hash: short, path: ''}), /signature/i)
})
