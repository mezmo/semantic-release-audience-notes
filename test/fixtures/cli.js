import {execFile} from 'node:child_process'
import {mkdir, mkdtemp, rm, writeFile} from 'node:fs/promises'
import {promisify} from 'node:util'
import {fileURLToPath} from 'node:url'
import {tmpdir} from 'node:os'
import path from 'node:path'

const run = promisify(execFile)
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const CLI = path.join(ROOT, 'bin/audience-notes.js')
const SECRET = 'sk-ant-test-value-that-must-never-be-printed'

// The published binary has no exports, so the only honest way to test it is to
// run it and read what a user would see.
async function cli(argv, env = {}, opts = {}) {
  try {
    const {stdout, stderr} = await run(
      process.execPath
    , [CLI, ...argv]
    , {env: {...process.env, ANTHROPIC_API_KEY: SECRET, ...env}, ...opts}
    )
    return {code: 0, stdout, stderr}
  } catch (err) {
    return {code: err.code, stdout: err.stdout || '', stderr: err.stderr || ''}
  }
}

async function json(t, argv, env, opts) {
  const result = await cli([...argv, '--json'], env, opts)
  t.equal(result.code, 0, result.stderr)
  return JSON.parse(result.stdout)
}

async function commit(cwd, files, message) {
  for (const [name, contents] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(cwd, name)), {recursive: true})
    await writeFile(path.join(cwd, name), contents)
  }
  await run('git', ['add', '-A'], {cwd})
  await run('git', ['commit', '--quiet', '-m', message], {cwd})
}

// Tagged v1.0.0 at a seed commit, with one feature commit after it.
async function makeRepo(t, {origin = true} = {}) {
  const cwd = await mkdtemp(path.join(tmpdir(), 'audience-notes-cli-'))
  t.teardown(() => { return rm(cwd, {recursive: true, force: true}) })

  await run('git', ['init', '--quiet', '-b', 'main'], {cwd})
  for (const [key, value] of [
    ['user.email', 'test@example.com']
  , ['user.name', 'Test']
  , ['commit.gpgsign', 'false']
  , ['core.hooksPath', cwd]
  ]) await run('git', ['config', key, value], {cwd})

  await commit(cwd, {'a.js': '1\n'}, 'chore: seed')
  await run('git', ['tag', 'v1.0.0'], {cwd})
  await commit(cwd, {'b.js': '2\n'}, 'feat(core): add the widget')
  if (origin) {
    const url = 'https://github.com/example/thing.git'
    await run('git', ['remote', 'add', 'origin', url], {cwd})
  }
  return cwd
}

export {
  CLI
, SECRET
, cli
, commit
, json
, makeRepo
, run
}
