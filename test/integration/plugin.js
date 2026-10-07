import {execFile} from 'node:child_process'
import {mkdtemp, mkdir, rm, symlink, writeFile} from 'node:fs/promises'
import {promisify} from 'node:util'
import {fileURLToPath} from 'node:url'
import {tmpdir} from 'node:os'
import path from 'node:path'

import {test} from 'tap'

import {describeEverything, startFakeApi} from '../fixtures/fake-api.js'

const run = promisify(execFile)
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

// Nothing else in the suite loads index.js, so the published entry point and the
// contract semantic-release actually calls were never exercised. This drives the
// real binary against a real repository and asserts only what a consumer sees.
// `tag` tags the first commit as v1.0.0, so the commits after it make a minor or
// patch release instead of a first one. `env` reaches semantic-release as given.
async function makeRelease(t, commits, {tag = false, env: extra = {}} = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'audience-notes-plugin-'))
  t.teardown(() => { return rm(root, {recursive: true, force: true}) })

  const cwd = path.join(root, 'repo')
  const origin = path.join(root, 'origin')
  // HEAD on a bare repo points at master unless it is told otherwise, and
  // semantic-release resolves the remote HEAD before it looks at any branch.
  await run('git', ['init', '--quiet', '--bare', '-b', 'main', origin])
  await mkdir(path.join(root, 'hooks'), {recursive: true})
  await mkdir(cwd, {recursive: true})
  await run('git', ['init', '--quiet', '-b', 'main'], {cwd})

  for (const [key, value] of [
    ['user.email', 'test@example.com']
  , ['user.name', 'Test']
  , ['commit.gpgsign', 'false']
    // An empty hooks directory, so a developer's global signing or lint hooks
    // cannot decide whether this test passes.
  , ['core.hooksPath', path.join(root, 'hooks')]
  ]) await run('git', ['config', key, value], {cwd})

  await run('git', ['remote', 'add', 'origin', origin], {cwd})
  for (const [index, message] of commits.entries()) {
    await writeFile(path.join(cwd, `file-${index}.js`), `${index}\n`)
    await run('git', ['add', '-A'], {cwd})
    await run('git', ['commit', '--quiet', '-m', message], {cwd})
    if (tag && index === 0) await run('git', ['tag', 'v1.0.0'], {cwd})
  }
  await run('git', ['push', '--quiet', '--tags', 'origin', 'main'], {cwd})

  // semantic-release resolves plugin names from the repository it is releasing.
  await symlink(path.join(ROOT, 'node_modules'), path.join(cwd, 'node_modules'))
  await writeFile(path.join(cwd, 'release.config.json'), JSON.stringify({
    branches: ['main']
  , plugins: [
      '@semantic-release/commit-analyzer'
      // By path, so the test covers the published entry point rather than a
      // package name that may resolve to something installed.
    , path.join(ROOT, 'index.js')
    ]
  }))

  // Without a key the run exits non-zero by design, and that failure is the
  // behaviour under test, so the output is read off the rejection.
  //
  // Only PATH and HOME are passed on. semantic-release asks env-ci for the branch
  // even under --no-ci, and a CI's own variables, such as Jenkins' BRANCH_NAME of
  // PR-1, end the run before verifyConditions does. No key or AWS profile reaches
  // it either.
  const env = {PATH: process.env.PATH, HOME: process.env.HOME, ...extra}
  const opts = {cwd, env}
  const argv = ['--dry-run', '--no-ci', '--extends', './release.config.json']
  try {
    const bin = path.join(ROOT, 'node_modules/.bin/semantic-release')
    const {stdout, stderr} = await run(bin, argv, opts)
    return `${stdout}\n${stderr}`
  } catch (err) {
    return `${err.stdout || ''}\n${err.stderr || ''}`
  }
}

test('semantic-release loads both plugin steps from the entry point', async (t) => {
  const log = await makeRelease(t, [
    'feat(core): add the widget\n\nWidgets are built lazily now.'
  , 'fix(core): stop the leak'
  ])

  t.match(log, /Loaded plugin "verifyConditions"/)
  t.match(log, /Loaded plugin "generateNotes"/)
})

test('a missing key stops the release instead of publishing other notes', async (t) => {
  // There is no fallback. The plugin replaces release-notes-generator, so degrading
  // to it would publish exactly what you would have had without the plugin, on a
  // green pipeline, for as many releases as it took someone to notice.
  const log = await makeRelease(t, ['fix(core): stop the leak'])

  t.match(log, /ENOAPIKEY/)
  t.match(log, /No API key found in the `ANTHROPIC_API_KEY` environment variable/)
  t.notMatch(log, /Published release/, 'nothing is published')
})

// The unit tests build semantic-release's context by hand. This runs a real dry
// run to the end, through the real SDK and a stand-in API, so the context that
// reaches the renderer is the one semantic-release actually builds.
test('a release runs to its notes through the real SDK', async (t) => {
  const api = await startFakeApi(t, describeEverything)
  const log = await makeRelease(t, [
    'chore: seed'
  , 'feat(core): add the widget'
  , 'fix(core): stop the leak'
  ], {tag: true, env: {ANTHROPIC_API_KEY: 'test-key', ANTHROPIC_BASE_URL: api.url}})

  t.equal(api.requests.length, 1, 'one turn submits the notes')
  const [kickoff] = api.requests[0].body.messages[0].content
  t.match(kickoff.text, /New version: 1\.1\.0/)
  t.match(kickoff.text, /Previous version: 1\.0\.0/)
  t.match(log, /Wrote 2 entries from 2 commits, omitted 0/)
  t.match(log, /Release note for version 1\.1\.0/)
  t.match(log, /Add the widget/)
  t.match(log, /Stop the leak/)
  // semantic-release logs "Published release" in a dry run too, so the dry run is
  // shown by the tag it declined to create.
  t.match(log, /Skip v1\.1\.0 tag creation in dry-run mode/)
})

