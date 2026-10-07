import {test} from 'tap'

import {build, resolveHash, toPayloadEntry} from '../../lib/commits.js'
import {describe} from '../../lib/repository.js'
import {normalize} from '../../lib/options.js'

const OPTIONS = normalize({}, {env: {}})
const REPOSITORY = describe('https://github.com/mezmo/repo.git')
const CONTEXT = {options: {}}

function run(commits, options = OPTIONS, context = CONTEXT) {
  return build(commits, options, context, REPOSITORY)
}

test('resolveHash() matches any form that names one commit', async (t) => {
  // Regression: the agent echoed full hashes back -- commit bodies quote them and
  // read_commit accepted them -- and the submission matched nothing. Coverage read
  // every commit as missing, the retry asked for the same hashes, and the whole
  // release went out as literal commit subjects.
  const byHash = new Map([['1cb0b3a', {}], ['055125d', {}]])

  t.equal(resolveHash('1cb0b3a', byHash), '1cb0b3a', 'the short hash it was given')
  t.equal(
    resolveHash('1cb0b3a9f8e7d6c5b4a3928170695847362514ab', byHash)
  , '1cb0b3a'
  , 'a full hash'
  )
  t.equal(resolveHash('1CB0B3A', byHash), '1cb0b3a', 'a different case')
  t.equal(resolveHash('  1cb0b3a  ', byHash), '1cb0b3a', 'surrounding space')
  t.equal(resolveHash('1cb0b', byHash), '1cb0b3a', 'a shorter unique abbreviation')
})

test('resolveHash() matches a full hash against a lengthened key', async (t) => {
  // Two commits sharing seven characters lengthen every key in the release, and a
  // fixed seven-character fallback then matched none of them.
  const byHash = new Map([['abc12345', {}], ['abc12346', {}]])

  t.equal(resolveHash(`abc12345${'f'.repeat(32)}`, byHash), 'abc12345')
  t.equal(resolveHash('abc1234', byHash), '', 'the shared prefix still names neither')
})

test('resolveHash() refuses anything it cannot pin to one commit', async (t) => {
  const byHash = new Map([['aaa1111', {}], ['aaa2222', {}]])

  t.equal(resolveHash('aaa', byHash), '', 'an abbreviation two commits share')
  t.equal(resolveHash('deadbee', byHash), '', 'a hash from no release')
  t.equal(resolveHash('', byHash), '', 'an empty string')
  t.equal(resolveHash(undefined, byHash), '', 'nothing at all')
  t.equal(resolveHash(null, byHash), '', 'or null')
})

test('build() extracts type, scope, subject, and breaking notes', async (t) => {
  const [entry] = run([{
    hash: 'aaaaaaaaaaaa'
  , message: 'feat(api-auth)!: shorten session lifetime\n\nBody text.\n\n'
      + 'BREAKING CHANGE: long sessions are invalidated.'
  }])

  t.equal(entry.hash, 'aaaaaaa', 'hash is shortened for display')
  t.equal(entry.fullHash, 'aaaaaaaaaaaa', 'full hash is retained for links')
  t.equal(entry.type, 'feat')
  t.equal(entry.scope, 'api-auth')
  t.equal(entry.subject, 'shorten session lifetime')
  t.equal(entry.body, 'Body text.')
  t.ok(entry.breaking)
  t.same(entry.breakingNotes, ['long sessions are invalidated.'])
})

test('build() treats a bare `!` marker as breaking', async (t) => {
  const [entry] = run([{hash: 'a1', message: 'refactor(core)!: drop the legacy path'}])
  t.ok(entry.breaking, 'the `!` marker is detected even with no BREAKING CHANGE note')
})

test('build() collects issue references using host prefixes', async (t) => {
  const [entry] = run([{hash: 'a1', message: 'fix(api): handle nulls\n\nfixes #42'}])
  t.same(entry.references, ['#42'])
})

test('build() honors custom parserOpts from the release config', async (t) => {
  const context = {
    options: {
      parserOpts: {
        issuePrefixes: ['LOG-', 'PROD-']
      , issuePrefixesCaseSensitive: true
      , referenceActions: ['ref']
      }
    }
  }
  const commit = {hash: 'a1', message: 'fix(api): tidy\n\nref: LOG-4821'}
  const [entry] = run([commit], OPTIONS, context)
  t.same(entry.references, ['LOG-4821'], 'Mezmo JIRA prefixes carry over from parserOpts')
})

test('build() drops commits that were reverted in the same release', async (t) => {
  // Regression: an internal `raw` field used to shadow the revert matcher's
  // `commit.raw || commit` lookup and silently disable this filter.
  const kept = run([
    {
      hash: '2222222222'
    , message: 'Revert "feat: add widget"\n\nThis reverts commit 1111111111.'
    }
  , {hash: '1111111111', message: 'feat: add widget'}
  , {hash: '3333333333', message: 'fix: keep me'}
  ])

  t.equal(kept.length, 1, 'the revert and its target are both removed')
  t.equal(kept[0].subject, 'keep me')
})

test('build() skips empty messages and honors commitOpts.ignore', async (t) => {
  const options = normalize({commitOpts: {ignore: '^chore\\(deps\\)'}}, {env: {}})
  const kept = run([
    {hash: 'a1', message: '   '}
  , {hash: 'a2', message: 'chore(deps): bump undici'}
  , {hash: 'a3', message: 'fix: real change'}
  ], options)

  t.equal(kept.length, 1)
  t.equal(kept[0].subject, 'real change')
})

test('build() honors commitOpts.ignore from the release config', async (t) => {
  const context = {options: {commitOpts: {ignore: '^skipme'}}}
  const kept = run([
    {hash: 'a1', message: 'skipme: internal'}
  , {hash: 'a2', message: 'fix: real change'}
  ], OPTIONS, context)

  t.equal(kept.length, 1)
})

test('build() reads a commit whose hash arrives in git-log-parser shape', async (t) => {
  // semantic-release hands over {commit: {long, short}} on some paths.
  const [entry] = run([{
    commit: {'long': 'ccc3333cccc', 'short': 'ccc3333'}
  , subject: 'fix(core): handle it'
  , body: 'Body line.'
  }])

  t.equal(entry.fullHash, 'ccc3333cccc')
  t.equal(entry.subject, 'handle it')
})

test('build() skips a commit with no hash at all', async (t) => {
  t.same(run([{message: 'fix: no hash anywhere'}]), [])
})

test('build() tolerates a missing repository descriptor', async (t) => {
  const [entry] = build([{hash: 'a1', message: 'fix: x'}], OPTIONS, CONTEXT, null)
  t.equal(entry.subject, 'x')
})

test('build() falls back to an unparseable header as the subject', async (t) => {
  const [entry] = run([{hash: 'a1', message: 'not a conventional header at all'}])

  t.equal(entry.type, '', 'no type is invented')
  t.equal(entry.scope, '')
  t.equal(entry.subject, 'not a conventional header at all')
  t.equal(entry.breaking, false)
  t.same(entry.references, [])
})

// The parser guarantees most of these fields, so the guards below are only
// reachable by calling the mapper directly. They exist because the shape comes
// from a third-party parser whose output we do not control.
test('toPayloadEntry() tolerates a parse result with no optional fields', async (t) => {
  const entry = toPayloadEntry({hash: 'a1b2c3d4', source: {}})

  t.equal(entry.hash, 'a1b2c3d')
  t.equal(entry.subject, '', 'no subject and no header yields an empty subject')
  t.equal(entry.type, '')
  t.equal(entry.scope, '')
  t.equal(entry.body, '')
  t.equal(entry.breaking, false, 'a missing header is not treated as a bang marker')
  t.same(entry.breakingNotes, [])
  t.same(entry.references, [])
})

test('toPayloadEntry() falls back to the header when there is no subject', async (t) => {
  const entry = toPayloadEntry(
    {hash: 'a1', header: 'feat(core)!: raw header', source: {}}
  , new Map()
  )

  t.equal(entry.subject, 'feat(core)!: raw header')
  t.ok(entry.breaking, 'the bang marker is read off the header')
})

test('toPayloadEntry() renders a half-formed reference', async (t) => {
  const entry = toPayloadEntry(
    {hash: 'a1', source: {}, references: [{prefix: '#'}, {issue: '42'}, {}]}
  , new Map()
  )

  t.same(entry.references, ['42'], 'a reference with no issue number is dropped')
})

test('build() keeps the owner and repo on a cross-repo reference', async (t) => {
  // A bare "#12" would link to this repository's issue 12, not the other one's.
  const [entry] = run([{
    hash: 'a1'
  , message: 'build(deps): update rig fork\n\nPin rig-core (mezmo/rig#12), Refs: #630'
  }])

  t.same(entry.references, ['mezmo/rig#12', '#630'])
})

test('build() treats only a breaking-change note as breaking', async (t) => {
  // A custom noteKeyword parses into the same notes list. Treating it as breaking
  // forces the commit into the breaking section and floors its importance.
  const options = normalize({}, {env: {}})
  const context = {
    cwd: process.cwd()
  , options: {parserOpts: {noteKeywords: ['BREAKING CHANGE', 'DEPRECATED']}}
  }
  function parse(message) {
    return build([{hash: 'a'.repeat(40), message}], options, context, describe(''))[0]
  }

  t.notOk(parse('fix(api): tighten it\n\nDEPRECATED: use v2').breaking)
  t.notOk(
    toPayloadEntry({
      hash: 'a'.repeat(40)
    , header: 'fix: a thing'
    , notes: [{text: 'loose'}]
    , references: []
    , source: {}
    }).breaking
  , 'a note with no title is not a breaking change either'
  )
  t.ok(parse('feat(api): change it\n\nBREAKING CHANGE: gone').breaking)
  t.ok(parse('feat(api)!: change it').breaking)
})

test('build() lengthens abbreviations until no two commits collide', async (t) => {
  // A fixed seven characters collapsed two commits into one map entry and the
  // loser vanished without ever counting as missing.
  const options = normalize({}, {env: {}})
  const context = {cwd: process.cwd(), options: {}}
  const commits = [
    {hash: `1234567${'a'.repeat(33)}`, message: 'feat: one'}
  , {hash: `1234567${'b'.repeat(33)}`, message: 'fix: two'}
  ]

  const built = build(commits, options, context, describe(''))
  t.equal(built.length, 2, 'both survive')
  t.equal(new Set(built.map((c) => { return c.hash })).size, 2, 'with distinct hashes')
  t.same(built.map((c) => { return c.hash }), ['1234567a', '1234567b'])
})

test('build() keeps the flags on a commitOpts.ignore pattern', async (t) => {
  // Rebuilding from .source alone dropped i, m and s along with the g it targeted.
  const options = normalize({}, {env: {}})
  function kept(ignore, messages) {
    const commits = messages.map((message, index) => {
      return {hash: String(index).repeat(40), message}
    })
    const context = {cwd: '.', options: {commitOpts: {ignore}}}
    return build(commits, options, context, describe(''))
  }

  t.equal(kept(/^wip/i, ['WIP: a', 'feat: b']).length, 1, 'a case-insensitive one')
  t.equal(kept(/skip/g, ['chore: skip', 'chore: skip']).length, 0, 'and a global one')
})
