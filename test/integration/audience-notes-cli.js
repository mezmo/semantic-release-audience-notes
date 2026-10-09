import {mkdir, writeFile} from 'node:fs/promises'
import path from 'node:path'

import tap, {test} from 'tap'

import {cli, json, makeRepo, SECRET} from '../fixtures/cli.js'
import {describeEverything, startFakeApi, toolUse} from '../fixtures/fake-api.js'

// Every test spawns git and the binary, which a busy CI agent runs slowly.
tap.setTimeout(120000)

test('--json never prints the api key it resolved', async (t) => {
  // The resolved options hold the key's value, so --json has to redact it.
  const cwd = await makeRepo(t)
  const {code, stdout} = await cli(['--cwd', cwd, '--from', 'v1.0.0', '--json'])

  t.equal(code, 0)
  t.notMatch(stdout, new RegExp(SECRET), 'the value never reaches stdout')
  t.match(stdout, /"apiKey": "\[redacted\]"/, 'and its presence is still visible')
})

test('--json reports the resolved config and the commits in range', async (t) => {
  const cwd = await makeRepo(t)
  const {stdout} = await cli([
    '--cwd', cwd, '--from', 'v1.0.0', '--json'
  , '--effort', 'xhigh', '--max-details', '2'
  ])

  const out = JSON.parse(stdout)
  t.equal(out.options.effort, 'xhigh', 'flags reach the resolved options')
  t.equal(out.options.limits.maxDetails, 2)
  t.equal(out.commits.length, 1, 'only the commits after the tag')
  t.match(out.commits[0].subject, /add the widget/)
})

test('an unreadable --config fails with the path, not a bare stack', async (t) => {
  const cwd = await makeRepo(t)
  const missing = path.join(cwd, 'nope.json')
  const argv = ['--cwd', cwd, '--from', 'v1.0.0', '--config', missing]
  const {code, stderr} = await cli(argv)

  t.equal(code, 1)
  t.match(stderr, /nope\.json/, 'naming the file it could not read')
})

test('every flag reaches the resolved config', async (t) => {
  const cwd = await makeRepo(t)
  await writeFile(path.join(cwd, 'cfg.js'), 'export default {title: "From the file"}\n')

  const out = await json(t, [
    '--cwd', cwd, '--from', 'v1.0.0', '--to', 'HEAD', '--version', 'v9.9.9'
  , '--config', path.join(cwd, 'cfg.js')
  , '--audience', 'operators', '--preset', 'keepachangelog', '--model', 'some-model'
  , '--max-tool-calls', '11', '--max-details', '3', '--verbose'
  ])

  t.equal(out.release.version, '9.9.9')
  t.equal(out.options.preset, 'keepachangelog')
  t.equal(out.options.title, 'From the file', 'a JS config module is loaded')
  t.equal(out.options.audience.name, 'operators')
  t.equal(out.options.model, 'some-model')
  t.equal(out.options.agent.maxToolCalls, 11)
  t.equal(out.options.limits.maxDetails, 3)
  t.ok(out.options.verbose)
})

test('bedrock resolves without a key and says which region', async (t) => {
  const cwd = await makeRepo(t)
  const argv = ['--cwd', cwd, '--from', 'v1.0.0', '--json', '--provider', 'bedrock']
  const {stdout, stderr} = await cli([...argv, '--region', 'us-east-1'], {
    ANTHROPIC_API_KEY: ''
  })

  t.match(stderr, /Using bedrock in us-east-1 as anthropic\./)
  t.equal(JSON.parse(stdout).options.region, 'us-east-1')
})

test('a missing key is called out before any work starts', async (t) => {
  const cwd = await makeRepo(t)
  const argv = ['--cwd', cwd, '--from', 'v1.0.0', '--json']
  const {stdout, stderr} = await cli(argv, {ANTHROPIC_API_KEY: ''})

  t.match(stderr, /ANTHROPIC_API_KEY is not set, so a run would fail\./)
  t.equal(JSON.parse(stdout).options.apiKey, '', 'and absence is not redacted')
})

test('a repository with no origin still renders', async (t) => {
  // `git remote get-url` exits non-zero rather than printing nothing, so the
  // repository url has to survive the failure rather than the empty string.
  const cwd = await makeRepo(t, {origin: false})
  const {code, stdout} = await cli(['--cwd', cwd, '--from', 'v1.0.0', '--json'])

  t.equal(code, 0)
  t.equal(JSON.parse(stdout).commits.length, 1, 'the range still resolves')
})

test('a real run without a key exits non-zero with the reason', async (t) => {
  // generateNotes checks for the key before it sends anything.
  const cwd = await makeRepo(t)
  const {code, stderr} = await cli(['--cwd', cwd, '--from', 'v1.0.0'], {
    ANTHROPIC_API_KEY: ''
  })

  t.equal(code, 1)
  t.match(stderr, /error: No API key found in the `ANTHROPIC_API_KEY` environment/)
  t.notMatch(stderr, /is not set/, 'said once, by the error itself')
})

test('a JSON config file is read without an import', async (t) => {
  // `import` of a .json needs an attribute, so these go through fs instead.
  const cwd = await makeRepo(t)
  await writeFile(path.join(cwd, 'cfg.json'), JSON.stringify({title: 'From JSON'}))

  const {stdout} = await cli([
    '--cwd', cwd, '--from', 'v1.0.0', '--json', '--config', path.join(cwd, 'cfg.json')
  ])
  t.equal(JSON.parse(stdout).options.title, 'From JSON')
})

test('a misspelled option in the config file is named on stderr', async (t) => {
  const cwd = await makeRepo(t)
  await writeFile(path.join(cwd, 'typo.json'), JSON.stringify({audiance: 'operators'}))

  const {stderr} = await cli([
    '--cwd', cwd, '--from', 'v1.0.0', '--json', '--config', path.join(cwd, 'typo.json')
  ])
  t.match(stderr, 'warn: `audiance` is not an option. Did you mean `audience`?')
})

test('an unknown preset renders as conventional and says so', async (t) => {
  const cwd = await makeRepo(t)

  const {stdout, stderr} = await cli([
    '--cwd', cwd, '--from', 'v1.0.0', '--json', '--preset', 'eslint'
  ])
  t.match(stderr, 'warn: `preset` is "eslint", which this plugin does not have')
  t.equal(JSON.parse(stdout).options.presetFallback, 'eslint')
})

test('a config module with no default export contributes nothing', async (t) => {
  const cwd = await makeRepo(t)
  await writeFile(path.join(cwd, 'named.js'), 'export const title = "ignored"\n')

  const {code, stdout} = await cli([
    '--cwd', cwd, '--from', 'v1.0.0', '--json', '--config', path.join(cwd, 'named.js')
  ])
  t.equal(code, 0, 'rather than crashing on an undefined default')
  t.notMatch(JSON.parse(stdout).options.title, /ignored/)
})

test('a config file loads from a path a URL would misread', async (t) => {
  const cwd = await makeRepo(t)
  const dir = path.join(cwd, 'c#d %20')
  await mkdir(dir)
  await writeFile(path.join(dir, 'cfg.mjs'), 'export default {title: "Odd path"}\n')
  await writeFile(path.join(dir, 'cfg.cjs'), 'module.exports = {title: "CommonJS"}\n')

  const odd = await json(t, ['--cwd', cwd, '--config', path.join(dir, 'cfg.mjs')])
  t.equal(odd.options.title, 'Odd path')
  const common = await json(t, ['--cwd', cwd, '--config', path.join(dir, 'cfg.cjs')])
  t.equal(common.options.title, 'CommonJS', 'and module.exports is its default')
})

test('a config file must hold an object', async (t) => {
  const cwd = await makeRepo(t)
  for (const [name, contents] of [
    ['null.json', 'null']
  , ['list.json', '["preset"]']
  , ['text.json', '"keepachangelog"']
  ]) {
    await writeFile(path.join(cwd, name), contents)
    const {code, stderr} = await cli(['--cwd', cwd, '--config', path.join(cwd, name)])
    t.equal(code, 1, name)
    t.match(stderr, `error: ${path.join(cwd, name)} must hold an object of plugin options.`)
  }

  await writeFile(path.join(cwd, 'opts.json'), '{"releaseOptions": "nope"}')
  const opts = await cli(['--cwd', cwd, '--config', path.join(cwd, 'opts.json')])
  t.match(opts.stderr, /error: `releaseOptions` in .*opts\.json must be an object\./)
})

test('a config module that throws a non-Error is still reported', async (t) => {
  const cwd = await makeRepo(t)
  await writeFile(path.join(cwd, 'throws.mjs'), 'throw "the config broke"\n')

  const config = path.join(cwd, 'throws.mjs')
  const {code, stderr} = await cli(['--cwd', cwd, '--config', config])
  t.equal(code, 1)
  t.equal(stderr, 'error: the config broke\n')
})

test('--json writes maps, patterns and the preset as they resolved', async (t) => {
  const cwd = await makeRepo(t)
  await writeFile(path.join(cwd, 'cfg.mjs'), [
    'export default {'
  , '  preset: "angular"'
  , ', typeSections: {svc: "features"}'
  , ', commitOpts: {ignore: /^wip/i}'
  , '}'
  ].join('\n'))

  const out = await json(t, ['--cwd', cwd, '--config', path.join(cwd, 'cfg.mjs')])
  t.equal(out.options.preset, 'conventional', 'an alias by its canonical name')
  t.equal(out.options.typeSections.svc, 'features')
  t.equal(out.options.commitOpts.ignore, '/^wip/i')

  const plain = await json(t, ['--cwd', cwd])
  t.equal(plain.options.preset, 'conventional', 'and the default when none is set')
})

test('a release config option the plugin ignores is named', async (t) => {
  const cwd = await makeRepo(t)
  await writeFile(path.join(cwd, 'cfg.json'), JSON.stringify({writerOpts: {}}))

  const config = path.join(cwd, 'cfg.json')
  const {stderr} = await cli(['--cwd', cwd, '--json', '--config', config])
  t.match(stderr, 'warn: Ignoring `writerOpts`.')
})

test('releaseOptions.repositoryUrl stands in for the origin remote', async (t) => {
  const cwd = await makeRepo(t)
  const url = 'https://gitlab.com/example/other.git'
  const config = {releaseOptions: {repositoryUrl: url}}
  await writeFile(path.join(cwd, 'cfg.json'), JSON.stringify(config))

  const out = await json(t, ['--cwd', cwd, '--config', path.join(cwd, 'cfg.json')])
  t.equal(out.release.repositoryUrl, url)
})

test('--json reports the package in --cwd, if its package.json names one', async (t) => {
  const cwd = await makeRepo(t)
  await writeFile(path.join(cwd, 'package.json'), JSON.stringify({version: '1.0.0'}))
  t.equal((await json(t, ['--cwd', cwd])).release.pkgName, '')

  await writeFile(path.join(cwd, 'package.json'), JSON.stringify({name: '@x/app'}))
  t.equal((await json(t, ['--cwd', cwd])).release.pkgName, '@x/app')
})

// These run the binary through to its output, against a local stand-in for the
// Anthropic API.
test('renders the notes for a range through the real SDK', async (t) => {
  const cwd = await makeRepo(t)
  const api = await startFakeApi(t, describeEverything)
  const {code, stdout, stderr} = await cli(
    ['--cwd', cwd, '--from', 'v1.0.0']
  , {ANTHROPIC_BASE_URL: api.url}
  )

  t.equal(code, 0)
  const compare = 'https://github.com/example/thing/compare/v1.0.0...HEAD'
  t.ok(stdout.startsWith(`# [next](${compare}) (`), 'the heading links the range')
  t.match(stdout, '### Features\n\n* **core:** Add the widget ([')
  t.match(stderr, '  Wrote 1 entries from 1 commits, omitted 0')
})

test('reports a commit the model never described', async (t) => {
  // Every submission is empty, so the plugin asks again until its retries run out
  // and then renders the commit from its subject.
  const cwd = await makeRepo(t)
  const api = await startFakeApi(t, (body, index) => {
    if (index > 2) return null
    return [toolUse('submit_release_notes', {entries: [], omitted: []})]
  })
  const {code, stdout, stderr} = await cli(
    ['--cwd', cwd, '--from', 'v1.0.0']
  , {ANTHROPIC_BASE_URL: api.url}
  )

  t.equal(code, 0)
  t.match(stderr, '  error: Wrote 1 commits as literal subjects')
  t.match(stdout, 'Add the widget')
})

test('warns when the config filters out every commit', async (t) => {
  const cwd = await makeRepo(t)
  const config = path.join(cwd, 'ignore-all.json')
  await writeFile(config, JSON.stringify({commitOpts: {ignore: '.'}}))
  const {code, stdout, stderr} = await cli(
    ['--cwd', cwd, '--from', 'v1.0.0', '--config', config]
  )

  t.equal(code, 0)
  t.equal(stdout, '', 'no notes to print')
  t.match(stderr, '  warn: All 1 commits were filtered out')
})

test('the prompt names the package in --cwd, not the one npx ran in', async (t) => {
  const cwd = await makeRepo(t)
  // Two runs share the server, and each opens with a request it has to answer.
  const api = await startFakeApi(t, (body) => { return describeEverything(body, 0) })
  const env = {ANTHROPIC_BASE_URL: api.url, npm_package_name: 'wrong-pkg'}
  function kickoff(index) {
    return api.requests[index].body.messages[0].content[0].text
  }

  t.equal((await cli(['--cwd', cwd, '--from', 'v1.0.0'], env)).code, 0)
  t.notMatch(kickoff(0), 'Package:', 'no package.json, so no package')

  await writeFile(path.join(cwd, 'package.json'), JSON.stringify({name: 'right-pkg'}))
  t.equal((await cli(['--cwd', cwd, '--from', 'v1.0.0'], env)).code, 0)
  t.match(kickoff(1), 'Package: right-pkg')
  t.notMatch(kickoff(1), 'wrong-pkg')
})

test('a first release renders without a compare link', async (t) => {
  const cwd = await makeRepo(t)
  const api = await startFakeApi(t, describeEverything)

  const {code, stdout} = await cli(['--cwd', cwd], {ANTHROPIC_BASE_URL: api.url})
  t.equal(code, 0)
  t.ok(stdout.startsWith('# next ('), 'there is no previous release to compare against')
})
