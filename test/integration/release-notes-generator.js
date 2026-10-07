import {fileURLToPath} from 'node:url'
import path from 'node:path'

import {test} from 'tap'
import {generateNotes as angular} from '@semantic-release/release-notes-generator'

import {createGenerateNotes} from '../../index.js'
import {resolve} from '../../lib/submission.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const QUIET = {log() {}, warn() {}, error() {}}
const SECTIONS = {feat: 'features', fix: 'fixes', perf: 'performance'}

// One commit of each kind Angular handles differently: a breaking feature with an
// issue reference, a scoped and an unscoped fix, a perf change, and a chore it hides.
const COMMITS = [
  {
    hash: `ba67342${'a'.repeat(33)}`
  , message: 'feat(api-auth): expire sessions after 15 minutes\n\n'
      + 'BREAKING CHANGE: Sessions now expire 15 minutes after they are issued.\n\n'
      + 'Closes #12'
  }
, {hash: `b03eef4${'b'.repeat(33)}`, message: 'fix(api-auth): keep refresh working'}
, {hash: `c111111${'c'.repeat(33)}`, message: 'fix: unscoped fix'}
, {hash: `d222222${'d'.repeat(33)}`, message: 'perf(db): faster'}
, {hash: `e333333${'e'.repeat(33)}`, message: 'chore(deps): bump'}
, {hash: `9666666${'f'.repeat(33)}`, message: 'feat(alpha): another feature'}
]

// Writes what Angular would, so any difference left is layout: each commit becomes
// an entry headlined by its subject, and the types Angular hides are omitted.
const agent = {
  async describe(payload) {
    const entries = payload.filter((commit) => { return SECTIONS[commit.type] })
    return resolve({
      entries: entries.map((commit) => {
        return {
          hashes: [commit.hash]
        , section: SECTIONS[commit.type]
        , scope: commit.scope
        , headline: commit.subject
        , details: []
        , importance: 'medium'
        , confidence: 'high'
        }
      })
    , omitted: payload.filter((commit) => { return !entries.includes(commit) })
        .map((commit) => { return {hash: commit.hash, reason: 'internal-only'} })
    }, payload)
  }
}
const ours = createGenerateNotes({createAgent: () => { return agent }})

const CASES = [
  ['a major release', {gitTag: 'v1.4.0'}, {version: '2.0.0', gitTag: 'v2.0.0'}, {}]
, ['a patch release', {gitTag: 'v1.4.0'}, {version: '1.4.1', gitTag: 'v1.4.1'}, {}]
, ['a first release', {}, {version: '1.0.0', gitTag: 'v1.0.0'}, {}]
, [
    'a release with links off'
  , {gitTag: 'v1.4.0'}
  , {version: '1.5.0', gitTag: 'v1.5.0'}
  , {linkReferences: false, linkCompare: false}
  ]
, [
    'a release with a custom host and paths'
  , {gitTag: 'v1.4.0'}
  , {version: '1.5.0', gitTag: 'v1.5.0'}
  , {host: 'https://git.example.com', commit: 'commits', issue: 'issue'}
  ]
]

// conventional promises the layout release-notes-generator renders with its
// default Angular preset. Our headlines are sentences the renderer capitalizes,
// and Angular prints the subject as written, so case is the one thing not compared.
for (const [name, lastRelease, nextRelease, config] of CASES) {
  test(`conventional matches release-notes-generator for ${name}`, async (t) => {
    const context = {
      cwd: ROOT
    , commits: COMMITS
    , lastRelease
    , nextRelease
    , options: {repositoryUrl: 'git@github.com:mezmo/aura.git'}
    , logger: QUIET
    , env: {ANTHROPIC_API_KEY: 'unused'}
    }
    const expected = await angular(config, context)
    const actual = await ours(config, context)
    t.equal(actual.toLowerCase(), expected.toLowerCase())
  })
}
