import {execFile} from 'node:child_process'
import {mkdtemp, rm, writeFile, mkdir} from 'node:fs/promises'
import {promisify} from 'node:util'
import {tmpdir} from 'node:os'
import path from 'node:path'

import {test} from 'tap'

import {createSession, createTools} from '../../lib/tools.js'
import {normalize} from '../../lib/options.js'

const run = promisify(execFile)

async function makeRepo(t) {
  const cwd = await mkdtemp(path.join(tmpdir(), 'audience-notes-detail-'))
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
function toolsFor(cwd, payload, agent = {}, context = {}) {
  const options = normalize({}, {env: {}})
  Object.assign(options.agent, agent)
  const session = createSession(payload, options, {cwd, ...context})
  const tools = new Map(createTools(session).map((tool) => {
    return [tool.name, tool]
  }))
  return {session, tools}
}

test('read_commit renders every optional field of a rich commit', async (t) => {
  const cwd = await makeRepo(t)
  await commit(cwd, {'seed.js': '0\n'}, 'chore: seed')
  const hash = await commit(
    cwd
  , {'lib/a.js': 'const a = 2\n', 'img/logo.png': 'PNGDATA'}
  , 'feat: rich commit'
  )

  const {tools} = toolsFor(cwd, [payloadFor(hash, {
    type: 'feat'
  , scope: 'core'
  , breaking: true
  , references: ['LOG-1', '#2']
  , breakingNotes: ['the old flag is gone.']
  , body: 'A body paragraph.'
  })])
  const out = await tools.get('read_commit').run({hash: hash.slice(0, 7)})

  t.match(out, /type: feat/)
  t.match(out, /scope: core/)
  t.match(out, /breaking: yes/)
  t.match(out, /references: LOG-1, #2/)
  t.match(out, /breaking note: the old flag is gone\./)
  t.notMatch(out, /body:/, 'the opening listing already carries the message')
})

test('read_commit returns the message when the listing had to drop it', async (t) => {
  const cwd = await makeRepo(t)
  const hash = await commit(cwd, {'a.js': '1\n'}, 'feat: a')

  const {tools} = toolsFor(
    cwd
  , [payloadFor(hash, {body: 'A body paragraph.'})]
  , {}
  , {listingTruncated: true}
  )
  const out = await tools.get('read_commit').run({hash: hash.slice(0, 7)})

  t.match(out, /body:\nA body paragraph\./, 'the only path that still needs it')
})

test('read_commit prints placeholders when type and scope are absent', async (t) => {
  const cwd = await makeRepo(t)
  const hash = await commit(cwd, {'a.js': '1\n'}, 'no conventional header')

  const {tools} = toolsFor(cwd, [payloadFor(hash, {type: '', scope: '', body: ''})])
  const out = await tools.get('read_commit').run({hash: hash.slice(0, 7)})

  t.match(out, /type: \(none\)/)
  t.match(out, /scope: \(none\)/)
  t.match(out, /breaking: no/)
  t.notMatch(out, /body:/)
})

test('read_commit labels a binary file rather than counting its lines', async (t) => {
  const cwd = await makeRepo(t)
  await commit(cwd, {'seed.js': '0\n'}, 'chore: seed')

  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01])
  const cwdPath = path.join(cwd, 'logo.png')
  await writeFile(cwdPath, png)
  await run('git', ['add', '-A'], {cwd})
  await run('git', ['commit', '--quiet', '-m', 'feat: add a logo'], {cwd})
  const {stdout} = await run('git', ['rev-parse', 'HEAD'], {cwd})
  const hash = stdout.trim()

  const {tools} = toolsFor(cwd, [payloadFor(hash)])
  t.match(await tools.get('read_commit').run({hash: hash.slice(0, 7)}), /\(binary\)/)
})

test('read_commit reports a commit that touched no included files', async (t) => {
  const cwd = await makeRepo(t)
  await commit(cwd, {'seed.js': '0\n'}, 'chore: seed')
  const hash = await commit(cwd, {'yarn.lock': 'lock\n'}, 'chore: lockfile only')

  const {tools} = toolsFor(cwd, [payloadFor(hash)])
  t.match(await tools.get('read_commit').run({hash: hash.slice(0, 7)}), /\(none\)/)
})

test('read_diff refuses a scoped path outside the repository', async (t) => {
  const cwd = await makeRepo(t)
  const hash = await commit(cwd, {'a.js': '1\n'}, 'feat: a')

  const {tools} = toolsFor(cwd, [payloadFor(hash)])
  const out = await tools.get('read_diff').run({
    hash: hash.slice(0, 7)
  , path: '../../etc/passwd'
  })
  t.match(out, /outside the repository/)
})

test('read_file and grep truncate oversized results', async (t) => {
  const cwd = await makeRepo(t)
  const big = Array.from({length: 300}, (unused, i) => {
    return `needle line ${i}`
  }).join('\n')
  const hash = await commit(cwd, {'big.txt': `${big}\n`}, 'feat: big')

  const {tools} = toolsFor(cwd, [payloadFor(hash)], {maxToolResultBytes: 512})

  t.match(await tools.get('read_file').run({path: 'big.txt'}), /file truncated/)

  // git grep stops at 50 per file, so the one file reports the cap it hit.
  const found = await tools.get('grep').run({pattern: 'needle', glob: ''})
  t.match(found, /50 matches in 1 file/)
  t.match(found, /big\.txt 50\+/)
})

test('grep counts per file when the result is too broad to return', async (t) => {
  const cwd = await makeRepo(t)
  const hash = await commit(cwd, {
    'many.txt': `${Array.from({length: 40}, () => { return 'needle' }).join('\n')}\n`
  , 'few.txt': 'needle\nneedle\n'
  , 'one.txt': 'needle\n'
  }, 'feat: spread')

  const {tools} = toolsFor(cwd, [payloadFor(hash)], {maxToolResultBytes: 512})
  const found = await tools.get('grep').run({pattern: 'needle', glob: ''})

  t.match(found, /43 matches in 3 files/)
  // Ordered by count so the densest file survives a truncated list.
  t.match(found, /many\.txt 40[\s\S]*few\.txt 2[\s\S]*one\.txt 1/)
  t.notMatch(found, /\+/, 'no file hit the per-file cap')
})

test('grep truncates the file list itself when there are too many files', async (t) => {
  const cwd = await makeRepo(t)
  const files = {}
  for (let index = 0; index < 30; index++) {
    files[`f${index}-a-rather-long-file-name.txt`] = 'needle\n'
  }
  const hash = await commit(cwd, files, 'feat: many files')

  const {tools} = toolsFor(cwd, [payloadFor(hash)], {maxToolResultBytes: 512})
  const found = await tools.get('grep').run({pattern: 'needle', glob: ''})

  t.match(found, /30 matches in 30 files/)
  t.match(found, /file list truncated/)
})

test('read_file reads a line range and numbers it', async (t) => {
  const cwd = await makeRepo(t)
  const lines = Array.from({length: 20}, (unused, i) => { return `line ${i + 1}` })
  const hash = await commit(cwd, {'a.txt': `${lines.join('\n')}\n`}, 'feat: a')

  const {tools} = toolsFor(cwd, [payloadFor(hash)])
  const out = await tools.get('read_file').run({path: 'a.txt', start: 5, end: 7})

  t.match(out, /lines 5-7 of 20:/)
  t.match(out, /5: line 5\n6: line 6\n7: line 7/)
  t.notMatch(out, /line 8/, 'stops at the end of the range')
})

test('read_file reads to the end when only a start is given', async (t) => {
  const cwd = await makeRepo(t)
  const hash = await commit(cwd, {'a.txt': 'one\ntwo\nthree\n'}, 'feat: a')

  const {tools} = toolsFor(cwd, [payloadFor(hash)])
  const out = await tools.get('read_file').run({path: 'a.txt', start: 2, end: 0})

  t.match(out, /lines 2-3 of 3:/)
  t.match(out, /3: three/)
})

test('read_file reads from the top when only an end is given', async (t) => {
  const cwd = await makeRepo(t)
  // No trailing newline, so the split leaves no empty final element to drop.
  const hash = await commit(cwd, {'a.txt': 'one\ntwo\nthree'}, 'feat: a')

  const {tools} = toolsFor(cwd, [payloadFor(hash)])
  const out = await tools.get('read_file').run({path: 'a.txt', start: 0, end: 2})

  t.match(out, /lines 1-2 of 3:/)
  t.notMatch(out, /three/)
})

test('read_file clamps a range that runs past the end of the file', async (t) => {
  const cwd = await makeRepo(t)
  const hash = await commit(cwd, {'a.txt': 'one\ntwo\n'}, 'feat: a')

  const {tools} = toolsFor(cwd, [payloadFor(hash)])
  t.match(
    await tools.get('read_file').run({path: 'a.txt', start: 9, end: 12})
  , /lines 2-2 of 2:/
  , 'clamped to the last line rather than returning nothing'
  )
})

test('read_file reads the whole file when no range is given', async (t) => {
  const cwd = await makeRepo(t)
  const hash = await commit(cwd, {'a.txt': 'one\ntwo\n'}, 'feat: a')

  const {tools} = toolsFor(cwd, [payloadFor(hash)])
  const out = await tools.get('read_file').run({path: 'a.txt', start: 0, end: 0})

  t.equal(out, 'one\ntwo\n', 'unnumbered and unchanged')
})

test('read_file refuses once the budget is spent', async (t) => {
  const cwd = await makeRepo(t)
  const hash = await commit(cwd, {'a.js': '1\n'}, 'feat: a')

  const {tools} = toolsFor(cwd, [payloadFor(hash)], {maxToolCalls: 1})
  await tools.get('read_commit').run({hash: hash.slice(0, 7)})
  t.match(await tools.get('read_file').run({path: 'a.js'}), /exhausted/)
})
