import {spawn} from 'node:child_process'
import {mkdtemp, open, rm, writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import path from 'node:path'

import tap, {test} from 'tap'

import {CLI, cli, commit, json, makeRepo, run, SECRET} from '../fixtures/cli.js'
import {signCommits} from '../fixtures/signed.js'

// Every test spawns git and the binary, which a busy CI agent runs slowly.
tap.setTimeout(120000)

test('--help lists the flags with the defaults the code actually uses', async (t) => {
  const {code, stdout} = await cli(['--help'])

  t.equal(code, 0)
  t.match(stdout, /--from <ref>/)
  t.match(stdout, /--effort <level>\s+low \| medium \| high \| xhigh \| max/)
  t.match(stdout, /--max-details <n>.*\(default: 4\)/, 'derived, so it cannot drift')
})

test('no --from covers every commit, like a first release', async (t) => {
  const cwd = await makeRepo(t)

  const out = await json(t, ['--cwd', cwd])
  t.equal(out.commits.length, 2, 'the root commit included')
  t.equal(out.release.from, null)
  t.equal(out.release.lastVersion, null)

  const empty = await json(t, ['--cwd', cwd, '--from', ''])
  t.equal(empty.commits.length, 2, 'and an empty --from means the same')
})

test('an empty range fails rather than rendering nothing', async (t) => {
  const cwd = await makeRepo(t)
  const {code, stderr} = await cli(['--cwd', cwd, '--from', 'HEAD'])

  t.equal(code, 1)
  t.match(stderr, /No commits in HEAD\.\.HEAD/)
})

test('an explicit --to names the version, HEAD falls back to next', async (t) => {
  const cwd = await makeRepo(t)
  await run('git', ['tag', 'v1.1.0'], {cwd})
  await run('git', ['branch', 'vendor-sync'], {cwd})

  const tagged = await json(t, ['--cwd', cwd, '--from', 'v1.0.0', '--to', 'v1.1.0'])
  t.equal(tagged.release.version, '1.1.0', 'a version tag loses its v')
  t.equal(tagged.release.lastVersion, '1.0.0')

  const head = await json(t, ['--cwd', cwd, '--from', 'v1.0.0'])
  t.equal(head.release.version, 'next')

  const branch = await json(t, ['--cwd', cwd, '--from', 'v1.0.0', '--to', 'vendor-sync'])
  t.equal(branch.release.version, 'vendor-sync', 'a name starting with v keeps it')
})

test('--to resolves to the commit it names when the run starts', async (t) => {
  const cwd = await makeRepo(t)
  const {stdout} = await run('git', ['rev-parse', 'HEAD'], {cwd})

  const out = await json(t, ['--cwd', cwd, '--from', 'v1.0.0'])
  t.equal(out.release.gitHead, stdout.trim(), 'so a moving branch cannot change the tree')
  t.equal(out.release.to, 'HEAD', 'while the heading keeps the name')
})

test('the working directory is used when --cwd is absent', async (t) => {
  const cwd = await makeRepo(t)
  const {code, stdout} = await cli(['--from', 'v1.0.0', '--json'], {}, {cwd})

  t.equal(code, 0)
  t.equal(JSON.parse(stdout).commits.length, 1, 'read from the process cwd')
})

test('a stray argument fails without running', async (t) => {
  const {code, stdout, stderr} = await cli(['v1.0.0'])

  t.equal(code, 1)
  t.equal(stdout, '', 'nothing a redirect would keep')
  t.match(stderr, 'error: Unexpected argument "v1.0.0". Every flag starts with --.')
  t.match(stderr, 'Run with --help for every flag.')
})

test('a flag with no value fails rather than becoming "true"', async (t) => {
  const cwd = await makeRepo(t)

  const swallowed = await cli(['--cwd', cwd, '--from', 'v1.0.0', '--audience', '--json'])
  t.equal(swallowed.code, 1)
  t.match(swallowed.stderr, 'error: --audience needs a value.')

  const trailing = await cli(['--cwd', cwd, '--from'])
  t.match(trailing.stderr, 'error: --from needs a value.')

  const empty = await cli(['--cwd', cwd, '--audience', ''])
  t.match(empty.stderr, 'error: --audience needs a value.')
})

test('an unknown flag fails and names the one it resembles', async (t) => {
  const typo = await cli(['--from', 'v1.0.0', '--efort', 'low'])
  t.equal(typo.code, 1)
  t.match(typo.stderr, 'error: Unknown flag --efort. Did you mean --effort?')

  const far = await cli(['--nothing-like-it'])
  t.match(far.stderr, /error: Unknown flag --nothing-like-it\.\n/)

  const valued = await cli(['--json=yes'])
  t.match(valued.stderr, 'error: --json takes no value.')
})

test('a flag can carry its value after =', async (t) => {
  const cwd = await makeRepo(t)
  const out = await json(t, [`--cwd=${cwd}`, '--from=v1.0.0', '--audience=operators'])

  t.equal(out.options.audience.name, 'operators')
  t.equal(out.commits.length, 1)
})

test('a count flag takes only a whole number', async (t) => {
  const cwd = await makeRepo(t)

  const word = await cli(['--cwd', cwd, '--max-tool-calls', 'lots'])
  t.match(word.stderr, 'error: --max-tool-calls needs a whole number.')

  const zero = await cli(['--cwd', cwd, '--max-details', '0', '--json'])
  t.equal(zero.code, 1, 'and the option itself rejects one out of range')
  t.match(zero.stderr, /limits\.maxDetails/)
})

test('a signed history reads the same as an unsigned one', async (t) => {
  // With log.showSignature on, git prints a signature check ahead of each record.
  const cwd = await makeRepo(t)
  if (!await signCommits(cwd)) return t.skip('ssh-keygen is not installed')
  await commit(cwd, {'c.js': '3\n'}, 'fix(core): signed change')

  const out = await json(t, ['--cwd', cwd, '--from', 'v1.0.0'])
  t.equal(out.commits.length, 2)
  for (const entry of out.commits) t.match(entry.hash, /^[0-9a-f]{40}$/)
})

test('an error prints its fix, and its stack only when verbose', async (t) => {
  const cwd = await makeRepo(t)
  const argv = ['--cwd', cwd, '--from', 'v1.0.0', '--provider', 'bedrock']
  const env = {AWS_REGION: '', AWS_DEFAULT_REGION: ''}

  const plain = await cli(argv, env)
  t.equal(plain.code, 1)
  t.match(plain.stderr, 'error: The `bedrock` provider needs a region.')
  t.match(plain.stderr, /AWS_REGION/, 'with the details that say how to fix it')
  t.notMatch(plain.stderr, /\n {4}at /, 'and no stack')

  const verbose = await cli([...argv, '--verbose'], env)
  t.match(verbose.stderr, /\n {4}at /, 'which --verbose adds')
})

test('a ref that names no commit fails before any work', async (t) => {
  const cwd = await makeRepo(t)
  const {code, stderr} = await cli(['--cwd', cwd, '--from', 'v1.0.0', '--to', 'nope'])

  t.equal(code, 1)
  t.match(stderr, `error: --to "nope" names no commit in ${cwd}.`)
  t.match(stderr, 'git fetch --tags')
})

test('--cwd has to be a directory inside a repository', async (t) => {
  const plain = await mkdtemp(path.join(tmpdir(), 'audience-notes-plain-'))
  t.teardown(() => { return rm(plain, {recursive: true, force: true}) })

  const missing = await cli(['--cwd', path.join(plain, 'servce')])
  t.match(missing.stderr, `error: ${path.join(plain, 'servce')} is not a directory.`)

  const outside = await cli(['--cwd', plain])
  t.match(outside.stderr, `error: ${plain} is not inside a git repository.`)
})

test('a package directory reads only the commits that touched it', async (t) => {
  const cwd = await makeRepo(t)
  await commit(cwd, {'packages/app/x.js': '1\n'}, 'feat(app): add x')
  await commit(cwd, {'packages/other/y.js': '1\n'}, 'feat(other): add y')
  const app = path.join(cwd, 'packages', 'app')

  const {stdout, stderr} = await cli(['--cwd', app, '--from', 'v1.0.0', '--json'])
  const out = JSON.parse(stdout)
  t.same(out.commits.map((entry) => { return entry.subject }), ['feat(app): add x'])
  t.equal(out.release.directory, 'packages/app')
  t.match(stderr, 'Reading 1 commits from v1.0.0..HEAD in packages/app')
})

test('a reader that closes early ends the run quietly', async (t) => {
  const cwd = await makeRepo(t)
  const child = spawn(process.execPath, [CLI, '--cwd', cwd, '--json'], {
    env: {...process.env, ANTHROPIC_API_KEY: SECRET}
  , stdio: ['ignore', 'pipe', 'pipe']
  })
  child.stdout.destroy()
  let stderr = ''
  child.stderr.on('data', (chunk) => { stderr += chunk })
  const code = await new Promise((resolve) => { child.on('close', resolve) })

  t.equal(code, 0)
  t.notMatch(stderr, /error/)
})

test('a stdout that cannot be written fails the run', async (t) => {
  const cwd = await makeRepo(t)
  const target = path.join(cwd, 'read-only.txt')
  await writeFile(target, '')
  const handle = await open(target, 'r')
  t.teardown(() => { return handle.close() })

  const child = spawn(process.execPath, [CLI, '--cwd', cwd, '--json'], {
    env: {...process.env, ANTHROPIC_API_KEY: SECRET}
  , stdio: ['ignore', handle.fd, 'pipe']
  })
  let stderr = ''
  child.stderr.on('data', (chunk) => { stderr += chunk })
  const code = await new Promise((resolve) => { child.on('close', resolve) })

  t.equal(code, 1)
  t.match(stderr, /error: .*EBADF/)
})
