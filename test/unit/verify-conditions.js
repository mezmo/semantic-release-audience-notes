import {test} from 'tap'

import {configWarnings, verifyConditions} from '../../lib/verify-conditions.js'
import {normalize} from '../../lib/options.js'

// Config validation runs before the git check, so these never reach a
// repository. The git-backed cases live in test/integration/verify-conditions.js.
function makeContext(overrides = {}) {
  return {
    cwd: process.cwd()
  , env: {ANTHROPIC_API_KEY: 'test-key'}
  , logger: {log() {}, warn() {}}
  , options: {}
  , ...overrides
  }
}

test('verifyConditions() rejects invalid configuration early', async (t) => {
  await t.rejects(verifyConditions({effort: 'turbo'}, makeContext()), /effort/)
})

test('verifyConditions() warns that an unknown preset falls back', async (t) => {
  const warnings = []
  const context = makeContext({logger: {warn: (message) => { warnings.push(message) }}})

  const options = await verifyConditions({preset: 'eslint'}, context)
  t.equal(options.presetFallback, 'eslint')
  t.equal(warnings.length, 1)
  t.match(warnings[0], /`preset` is "eslint".*"conventional"/)
})

test('verifyConditions() requires a git repository', async (t) => {
  await t.rejects(verifyConditions({}, makeContext({cwd: '/'})), {code: 'ENOGITREPO'})
})

test('verifyConditions() does not demand an Anthropic key under bedrock', async (t) => {
  const context = {
    cwd: '/'
  , env: {AWS_REGION: 'us-east-1'}
  , options: {}
  , logger: {warn() { t.fail('should not warn about a key it does not need') }}
  }

  // Reaches and fails the git check rather than the credential check.
  await t.rejects(
    verifyConditions({provider: 'bedrock'}, context)
  , {code: 'ENOGITREPO'}
  )
})

test('verifyConditions() refuses a missing key by default', async (t) => {
  // The default used to hand off to release-notes-generator, so a wrong key or a
  // bad region read as "the notes look like they used to" and survived a green
  // pipeline forever. Degrading is now something you ask for.
  await t.rejects(
    verifyConditions({}, {cwd: process.cwd(), env: {}, options: {}, logger: {warn() {}}})
  , {code: 'ENOAPIKEY'}
  )
})

test('verifyConditions() warns about generator options it ignores', async (t) => {
  const warnings = []
  const context = makeContext({logger: {warn: (message) => { warnings.push(message) }}})

  await verifyConditions({writerOpts: {}, presetConfig: {}}, context)
  t.match(warnings[0], /Ignoring `writerOpts`, `presetConfig`/)

  warnings.length = 0
  await verifyConditions({preset: 'angular'}, context)
  t.same(warnings, [], 'nothing to warn about')

  await verifyConditions(null, context)
  t.same(warnings, [], 'a missing config is not an ignored option')

  const global = {writerOpts: {transform() {}}}
  await verifyConditions(
    {...global}
  , makeContext({options: global, logger: context.logger})
  )
  t.same(warnings, [], 'nor is one every plugin got from the global config')

  await verifyConditions(
    {writerOpts: {}}
  , makeContext({options: global, logger: context.logger})
  )
  t.match(warnings[0], /Ignoring `writerOpts`\./, 'but one set for this plugin is')

  warnings.length = 0
  await verifyConditions(
    {writerOpts: {}}
  , makeContext({options: undefined, logger: context.logger})
  )
  t.match(warnings[0], /Ignoring `writerOpts`\./, 'with no global config to compare')

  await t.resolves(
    verifyConditions({writerOpts: {}}, makeContext({logger: undefined}))
  , 'and a context with no logger is fine'
  )
})

test('verifyConditions() names the option a misspelled key is meant to be', async (t) => {
  const warnings = []
  const context = makeContext({logger: {warn: (message) => { warnings.push(message) }}})

  await verifyConditions({audiance: 'operators', branches: ['main']}, context)
  t.same(warnings, ['`audiance` is not an option. Did you mean `audience`?'])
})

test('configWarnings() lists every warning in one place', async (t) => {
  const config = {preset: 'eslint', writerOpts: {}, audiance: 'operators'}
  const warnings = configWarnings(config, {options: {}}, normalize(config, {env: {}}))

  t.equal(warnings.length, 3)
  t.match(warnings[0], /`preset` is "eslint"/)
  t.match(warnings[1], /Ignoring `writerOpts`/)
  t.match(warnings[2], /`audiance` is not an option/)
  const clean = normalize({}, {env: {}})
  t.same(configWarnings({}, {}, clean), [], 'and none for a clean config')
})
