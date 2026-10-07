import {test} from 'tap'

import {resolve, unaccounted} from '../../lib/submission.js'
import {normalize} from '../../lib/options.js'

// Keep a Changelog with both opt-in sections, the layout Upgrade notes tests need.
const EXTRAS = {preset: 'keepachangelog', extraSections: ['upgrade', 'contributors']}

// Entries here name no section, so the table needs a fallback to file them in.
// Neither preset's own table has one; For contributors is.
const OPTIONS = normalize(EXTRAS, {env: {}})

function change(hash, overrides = {}) {
  return {
    hash
  , fullHash: `${hash}${'0'.repeat(33)}`
  , subject: 'do the thing'
  , type: 'fix'
  , scope: 'core'
  , breaking: false
  , breakingNotes: []
  , references: []
  , ...overrides
  }
}

const PAYLOAD = [change('aaa1111'), change('bbb2222'), change('ccc3333')]

function submission(overrides = {}) {
  return {entries: [], omitted: [], ...overrides}
}

test('resolve() turns every hash into the commit it names', async (t) => {
  const out = resolve(submission({
    entries: [{hashes: ['aaa1111', 'bbb2222'], headline: 'Two things'}]
  , omitted: [{hash: 'ccc3333', reason: 'trivial'}]
  }), PAYLOAD)

  t.same(
    out.entries[0].commits.map((commit) => { return commit.hash })
  , ['aaa1111', 'bbb2222']
  , 'entries carry commits'
  )
  t.equal(
    out.entries[0].headline
  , 'Two things'
  , 'and keep everything else the agent wrote'
  )
  t.equal(out.omitted[0].commit.hash, 'ccc3333', 'omissions carry one commit')
  t.same(out.unresolved, [])
  t.equal(out.payload, PAYLOAD, 'the release travels with the submission')
})

test('resolve() accepts any form that names one commit', async (t) => {
  const out = resolve(submission({
    entries: [{hashes: ['aaa1111' + '0'.repeat(33), 'BBB2222', ' ccc3 ']}]
  }), PAYLOAD)

  t.same(
    out.entries[0].commits.map((commit) => { return commit.hash })
  , ['aaa1111', 'bbb2222', 'ccc3333']
  , 'a full hash, a different case, and a padded abbreviation'
  )
  t.same(out.unresolved, [])
})

test('resolve() collects what named nothing instead of dropping it', async (t) => {
  // The bug this boundary exists for: a hash matching no commit used to be
  // skipped with `continue` at five separate call sites, so a submission we could
  // not read looked identical to an agent that had forgotten half the release.
  const out = resolve(submission({
    entries: [{hashes: ['aaa1111', 'deadbee', '']}]
  , omitted: [{hash: 'nope999', reason: 'trivial'}]
  }), PAYLOAD)

  t.same(out.entries[0].commits.map((c) => { return c.hash }), ['aaa1111'])
  t.same(out.unresolved, ['deadbee', '', 'nope999'], 'each one is reported verbatim')
  t.equal(out.omitted.length, 0, 'an omission naming nothing omits nothing')
})

test('resolve() refuses an abbreviation more than one commit answers to', async (t) => {
  const payload = [change('aaa1111'), change('aaa2222')]
  const out = resolve(submission({entries: [{hashes: ['aaa']}]}), payload)

  t.same(out.entries[0].commits, [])
  t.same(out.unresolved, ['aaa'], 'ambiguity is a failure, not a guess')
})

test('resolve() counts a commit named twice in one entry once', async (t) => {
  const out = resolve(submission({
    entries: [{hashes: ['aaa1111', 'aaa1111' + '0'.repeat(33)]}]
  }), PAYLOAD)

  t.same(out.entries[0].commits.map((c) => { return c.hash }), ['aaa1111'])
  t.same(out.unresolved, [], 'a repeat is a typo, not an unresolved hash')
})

test('resolve() survives a submission with nothing in it', async (t) => {
  for (const raw of [null, undefined, {}, {entries: 'nope', omitted: 'nope'}]) {
    const out = resolve(raw, PAYLOAD)
    t.same(out.entries, [], `entries for ${JSON.stringify(raw)}`)
    t.same(out.omitted, [])
    t.same(out.unresolved, [])
  }

  const out = resolve(submission({entries: [{headline: 'No hashes'}]}), PAYLOAD)
  t.same(out.entries[0].commits, [], 'an entry with no hashes claims nothing')
})

test('unaccounted() names commits the submission mentioned nowhere', async (t) => {
  const out = resolve(submission({
    entries: [{hashes: ['aaa1111']}]
  , omitted: [{hash: 'bbb2222', reason: 'trivial'}]
  }), PAYLOAD)

  t.same(unaccounted(out, OPTIONS), ['ccc3333'])
})

test('unaccounted() reports nothing when every commit is spoken for', async (t) => {
  const out = resolve(submission({
    entries: [{hashes: ['aaa1111', 'bbb2222', 'ccc3333']}]
  }), PAYLOAD)

  t.same(unaccounted(out, OPTIONS), [])
})

test('unaccounted() does not count an unresolved hash as coverage', async (t) => {
  // Reporting these as covered would hide the broken lookup; reporting them as
  // forgotten would send the agent looking for commits it already named.
  const out = resolve(submission({entries: [{hashes: ['deadbee']}]}), PAYLOAD)

  t.same(unaccounted(out, OPTIONS), ['aaa1111', 'bbb2222', 'ccc3333'])
  t.same(out.unresolved, ['deadbee'], 'the reason is on the submission, not in the gap')
})

test('resolve() separates supporting commits from the change itself', async (t) => {
  const out = resolve(submission({
    entries: [{hashes: ['aaa1111'], supporting: ['bbb2222'], headline: 'A feature'}]
  }), PAYLOAD)

  t.same(out.entries[0].commits.map((c) => { return c.hash }), ['aaa1111'])
  t.same(out.entries[0].supporting.map((c) => { return c.hash }), ['bbb2222'])
  t.same(unaccounted(out, OPTIONS), ['ccc3333'], 'supporting commits count as covered')
})

test('resolve() promotes a breaking or feature commit out of supporting', async (t) => {
  // Refusing the demotion has to promote, not drop. Dropping would report the
  // commit as forgotten, which is the confusion this boundary exists to prevent.
  const payload = [
    change('aaa1111')
  , change('bbb2222', {breaking: true})
  , change('ccc3333', {type: 'feat'})
  ]
  const out = resolve(submission({
    entries: [{hashes: ['aaa1111'], supporting: ['bbb2222', 'ccc3333']}]
  }), payload)

  t.same(
    out.entries[0].commits.map((c) => { return c.hash })
  , ['aaa1111', 'bbb2222', 'ccc3333']
  , 'both join the entry as full members'
  )
  t.same(out.entries[0].supporting, [])
  t.same(unaccounted(out, OPTIONS), [], 'and neither is lost')
})

test('resolve() makes supporting the change when there is no other', async (t) => {
  const out = resolve(submission({
    entries: [{hashes: [], supporting: ['aaa1111']}]
  }), PAYLOAD)

  t.same(out.entries[0].commits.map((c) => { return c.hash }), ['aaa1111'])
  t.same(out.entries[0].supporting, [], 'nothing is left supporting nothing')
})

test('resolve() will not let one commit be both', async (t) => {
  const out = resolve(submission({
    entries: [{hashes: ['aaa1111'], supporting: ['aaa1111']}]
  }), PAYLOAD)

  t.same(out.entries[0].commits.map((c) => { return c.hash }), ['aaa1111'])
  t.same(out.entries[0].supporting, [])
})

test('resolve() defaults supporting to empty when the agent omits it', async (t) => {
  const out = resolve(submission({entries: [{hashes: ['aaa1111']}]}), PAYLOAD)
  t.same(out.entries[0].supporting, [])
})

test('resolve() lets a commit with no type be supporting', async (t) => {
  // Only a feature and a breaking change are refused. Anything the table cannot
  // classify carries no claim on the reader's attention.
  const untyped = change('bbb2222')
  delete untyped.type
  const out = resolve(submission({
    entries: [{hashes: ['aaa1111'], supporting: ['bbb2222']}]
  }), [change('aaa1111'), untyped])

  t.same(out.entries[0].supporting.map((c) => { return c.hash }), ['bbb2222'])
})

test('unaccounted() catches a commit the one-claim rail would orphan', async (t) => {
  // The rail drops an entry whose own commits were all claimed above it, and the
  // supporting commits go with it. Counting `supporting` as coverage on its own
  // passed that submission and then rendered the commit as a bare subject.
  const out = resolve(submission({
    entries: [
      {hashes: ['aaa1111'], headline: 'First claim'}
    , {hashes: ['aaa1111'], supporting: ['ccc3333'], headline: 'Dropped duplicate'}
    ]
  , omitted: [{hash: 'bbb2222', reason: 'trivial'}]
  }), PAYLOAD)

  t.same(unaccounted(out, OPTIONS), ['ccc3333'])
})
