import {execFile} from 'node:child_process'
import {mkdtemp, rm} from 'node:fs/promises'
import {promisify} from 'node:util'
import {tmpdir} from 'node:os'
import path from 'node:path'

import {test} from 'tap'

import {verifyConditions} from '../../lib/verify-conditions.js'

const run = promisify(execFile)

async function makeRepo(t) {
  const cwd = await mkdtemp(path.join(tmpdir(), 'audience-notes-verify-'))
  t.teardown(() => { return rm(cwd, {recursive: true, force: true}) })
  await run('git', ['init', '--quiet', '-b', 'main'], {cwd})
  return cwd
}

function makeContext(overrides = {}) {
  return {
    env: {ANTHROPIC_API_KEY: 'test-key'}
  , logger: {log() {}, warn() {}}
  , options: {}
  , ...overrides
  }
}

test('verifyConditions() returns the normalized options when valid', async (t) => {
  const cwd = await makeRepo(t)
  const options = await verifyConditions({audience: 'security'}, makeContext({cwd}))
  t.equal(options.audience.name, 'security')
})

test('verifyConditions() tolerates a context with no logger', async (t) => {
  const cwd = await makeRepo(t)
  const env = {ANTHROPIC_API_KEY: 'k'}
  const options = await verifyConditions({}, {cwd, env, options: {}})
  t.equal(options.audience.name, 'developers')
})

test('verifyConditions() checks the process cwd when the context has none', async (t) => {
  // Asserting against the real process.cwd() made the unit-test version pass only
  // while this package was not itself a git repository, so `git init` here failed
  // the suite.
  const cwd = await makeRepo(t)
  const previous = process.cwd()
  process.chdir(cwd)
  t.teardown(() => { process.chdir(previous) })

  const options = await verifyConditions({}, makeContext({cwd: undefined}))
  t.equal(options.audience.name, 'developers', 'the cwd it falls back to is checked')
})
