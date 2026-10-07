import {test} from 'tap'

import {
  bounded
, clamp
, importanceOf
, sanitize
, fromCommit
, normalize as normalizeEntries
, scopeOf
, sentence
} from '../../lib/entries.js'
import {normalize} from '../../lib/options.js'
import {resolve} from '../../lib/submission.js'

// Keep a Changelog with both opt-in sections, the layout Upgrade notes tests need.
const EXTRAS = {preset: 'keepachangelog', extraSections: ['upgrade', 'contributors']}

// normalize() takes a resolved submission now, so tests still write the raw shape
// an agent submits and cross the boundary here.
function shape(raw, payload, options) {
  return normalizeEntries(resolve(raw, payload), options)
}

// The rails below are about the moving form, so they run against a table that
// moves a breaking entry into its section. The default restates instead, which
// has its own tests at the end.
const OPTIONS = normalize({
  sections: [
    {id: 'breaking', title: 'Breaking Changes'}
  , {id: 'features', title: 'Features', types: ['feat']}
  , {id: 'fixes', title: 'Fixes', types: ['fix']}
  , {id: 'performance', title: 'Performance', types: ['perf']}
  , {id: 'internal', title: 'Internal', types: ['chore']}
  ]
, actionSection: ''
}, {env: {}})

function commit(overrides) {
  return {
    hash: 'bbb2222'
  , fullHash: 'bbb2222000'
  , subject: 'handle empty lines'
  , type: 'fix'
  , scope: 'parser'
  , breaking: false
  , breakingNotes: []
  , references: []
  , ...overrides
  }
}

const BREAKING = commit({
  hash: 'aaa1111'
, fullHash: 'aaa1111000'
, subject: 'shorten session lifetime'
, type: 'feat'
, scope: 'api-auth'
, breaking: true
, references: ['LOG-1']
})

const PAYLOAD = [BREAKING, commit({})]

function entry(overrides) {
  return {
    hashes: ['bbb2222']
  , section: 'fixes'
  , scope: ''
  , headline: 'x'
  , details: []
  , importance: 'medium'
  , confidence: 'high'
  , ...overrides
  }
}

function result(overrides) {
  return {entries: [], omitted: [], ...overrides}
}

test('normalize() strips markdown and emoji, then fixes casing', async (t) => {
  const out = shape(result({
    entries: [entry({
      scope: 'parser'
    , headline: 'parser no longer crashes \u{1F389}'
    , details: ['fewer restarts', 'redeploy the collector']
    })]
  , omitted: [{hash: 'aaa1111', reason: 'trivial'}]
  }), PAYLOAD, OPTIONS)

  t.equal(out.entries[0].headline, 'Parser no longer crashes.')
  t.same(out.entries[0].details, ['Fewer restarts.', 'Redeploy the collector.'])
})

test('normalize() collapses several commits into one grouped entry', async (t) => {
  const payload = [
    commit({hash: 'ccc3333', fullHash: 'ccc3333000', references: ['LOG-1']})
  , commit({})
  ]
  const out = shape(result({
    entries: [entry({hashes: ['ccc3333', 'bbb2222'], headline: 'one change'})]
  }), payload, OPTIONS)

  t.equal(out.entries.length, 1, 'two commits became one line')
  t.same(out.entries[0].hashes, ['ccc3333', 'bbb2222'])
  t.same(
    out.entries[0].commits.map((c) => { return c.fullHash })
  , ['ccc3333000', 'bbb2222000']
  , 'both commits stay linkable'
  )
  t.same(out.entries[0].references, ['LOG-1'], 'references merge across the group')
  t.equal(out.missing.length, 0)
})

test('normalize() lets a grouped entry inherit breaking from any member', async (t) => {
  const out = shape(result({
    entries: [entry({hashes: ['bbb2222', 'aaa1111'], section: 'fixes'})]
  }), PAYLOAD, OPTIONS)

  t.equal(out.entries[0].section, 'breaking')
  t.ok(out.entries[0].breaking)
})

test('normalize() drops commits the agent deliberately omitted', async (t) => {
  const out = shape(result({
    entries: [entry({hashes: ['aaa1111'], section: 'breaking'})]
  , omitted: [{hash: 'bbb2222', reason: 'internal-only'}]
  }), PAYLOAD, OPTIONS)

  t.equal(out.entries.length, 1)
  t.equal(out.omitted.length, 1)
  t.equal(out.omitted[0].reason, 'internal-only')
  t.equal(out.omitted[0].subject, 'Handle empty lines.')
  t.equal(out.missing.length, 0, 'a deliberate omission is not an oversight')
})

test('normalize() refuses to omit a breaking change whatever the audience', async (t) => {
  const out = shape(result({
    entries: [entry({})]
  , omitted: [{hash: 'aaa1111', reason: 'no-audience-impact'}]
  }), PAYLOAD, OPTIONS)

  t.equal(out.omitted.length, 0, 'the omission is refused')
  const sections = out.entries.map((e) => { return e.section })
  t.ok(sections.includes('breaking'), 'it is filed under breaking instead')
})

test('normalize() coerces an unknown omission reason', async (t) => {
  const out = shape(result({
    omitted: [{hash: 'bbb2222', reason: 'because-i-said-so'}]
  }), PAYLOAD, OPTIONS)
  t.equal(out.omitted[0].reason, 'no-audience-impact')
})

test('normalize() gives a commit to only the first entry that claims it', async (t) => {
  const out = shape(result({
    entries: [
      entry({hashes: ['bbb2222'], headline: 'first'})
    , entry({hashes: ['bbb2222'], headline: 'second'})
    ]
  }), PAYLOAD, OPTIONS)

  t.equal(out.entries.length, 1, 'a commit never appears on two lines')
  t.equal(out.entries[0].headline, 'First.')
})

test('normalize() rejects hashes that are not in the release', async (t) => {
  const out = shape(result({
    entries: [entry({hashes: ['zzz9999', 'bbb2222']})]
  , omitted: [{hash: 'yyy8888', reason: 'trivial'}]
  }), PAYLOAD, OPTIONS)

  t.same(out.entries[0].hashes, ['bbb2222'], 'the invented hash is dropped')
  t.equal(out.omitted.length, 0, 'so is the invented omission')
})

test('normalize() reports commits accounted for nowhere', async (t) => {
  const out = shape(result({}), PAYLOAD, OPTIONS)
  t.same(out.missing.map((c) => { return c.hash }), ['aaa1111', 'bbb2222'])
})

test('normalize() drops an entry whose hashes were all claimed already', async (t) => {
  const out = shape(result({
    entries: [entry({hashes: ['bbb2222']}), entry({hashes: ['bbb2222']})]
  }), PAYLOAD, OPTIONS)
  t.equal(out.entries.length, 1)
})

test('normalize() falls back to the commit subject on an empty headline', async (t) => {
  const out = shape(result({
    entries: [entry({headline: '', confidence: 'low'})]
  }), PAYLOAD, OPTIONS)
  t.equal(out.entries[0].headline, 'Handle empty lines.')
})

test('normalize() coerces unknown section and confidence values', async (t) => {
  const out = shape(result({
    entries: [entry({section: 'inventions', confidence: 'certain'})]
  }), PAYLOAD, OPTIONS)

  t.equal(out.entries[0].section, 'internal')
  t.equal(out.entries[0].confidence, 'low')
})

test('fromCommit() derives a section from the conventional type', async (t) => {
  t.equal(fromCommit(commit({type: 'feat'}), OPTIONS).section, 'features')
  t.equal(fromCommit(commit({type: 'perf'}), OPTIONS).section, 'performance')
  t.equal(fromCommit(commit({type: 'chore'}), OPTIONS).section, 'internal')
  t.equal(fromCommit(BREAKING, OPTIONS).section, 'breaking')
  t.same(fromCommit(commit({}), OPTIONS).hashes, ['bbb2222'])
})

test('scopeOf() keeps identifier characters but normalizes the rest', async (t) => {
  t.equal(scopeOf('API_Auth!!', 32), 'api_auth', 'underscores survive markdown stripping')
  t.equal(scopeOf('ingest/pipeline', 32), 'ingest/pipeline')
  t.equal(scopeOf('  Weird  Scope  ', 32), 'weird-scope')
  t.equal(scopeOf('', 32), '')
})

test('clamp() truncates on a word boundary', async (t) => {
  // The boundary must fall past 60% of the limit to be used; otherwise the text
  // is hard-cut rather than losing most of its content to an early space.
  t.equal(clamp('aaaaaaaa bbbbbbbb', 12), 'aaaaaaaa', 'a late boundary is used')
  t.equal(clamp('a bbbbbbbbbbbbbbbbbb', 10), 'a bbbbbbbb', 'an early one is not')
  t.equal(clamp('short', 40), 'short')
})

test('sentence() capitalizes and terminates only when asked', async (t) => {
  t.equal(sentence('hello', true), 'Hello.')
  t.equal(sentence('hello.', true), 'Hello.')
  t.equal(sentence('hello', false), 'Hello')
  t.equal(sentence('', true), '')
})

test('normalize() keeps inline code but strips layout-breaking markers', async (t) => {
  const out = shape(result({
    entries: [entry({
      headline: 'Set `prompt_caching = true` under `[agent.llm]`'
    , details: [
        '- a leading bullet would nest inside the list'
      , '### a heading would break the document'
      , 'aura.usage gains cache_read_input_tokens'
      ]
    })]
  }), PAYLOAD, OPTIONS)

  const [first] = out.entries
  t.equal(
    first.headline
  , 'Set `prompt_caching = true` under `[agent.llm]`.'
  , 'identifiers survive intact'
  )
  t.equal(first.details[0], 'A leading bullet would nest inside the list.')
  t.equal(first.details[1], 'A heading would break the document.')
  t.equal(first.details[2], 'aura.usage gains cache_read_input_tokens.')
})

test('normalize() caps how many detail sentences an entry may carry', async (t) => {
  const out = shape(result({
    entries: [entry({details: ['one', 'two', 'three', 'four', 'five', 'six']})]
  }), PAYLOAD, OPTIONS)

  t.equal(out.entries[0].details.length, OPTIONS.limits.maxDetails)
})

test('normalize() drops empty detail sentences', async (t) => {
  const out = shape(result({
    entries: [entry({details: ['kept', '', '   ', null]})]
  }), PAYLOAD, OPTIONS)

  t.same(out.entries[0].details, ['Kept.'])
})

test('normalize() does not recase an identifier at the start of a line', async (t) => {
  const out = shape(result({
    entries: [entry({
      headline: 'aura.usage gains cache_read_input_tokens'
    , details: [
        '/mcp add works on agents loaded from a directory'
      , '`prompt_caching` defaults to off'
      , 'the parser no longer crashes'
      ]
    })]
  }), PAYLOAD, OPTIONS)

  const [first] = out.entries
  t.equal(first.headline, 'aura.usage gains cache_read_input_tokens.')
  t.equal(first.details[0], '/mcp add works on agents loaded from a directory.')
  t.equal(first.details[1], '`prompt_caching` defaults to off.')
  t.equal(
    first.details[2]
  , 'The parser no longer crashes.',
    'ordinary prose still gets cased'
  )
})

test('normalize() files a breaking change in the configured breaking', async (t) => {
  // Regression: this was hardcoded to "breaking". Under a taxonomy without that
  // section the entry landed somewhere the renderer never iterates, so a
  // breaking change silently disappeared from the notes.
  const options = normalize(EXTRAS, {env: {}})
  const out = shape(result({
    entries: [entry({hashes: ['aaa1111'], section: 'removed'})]
  }), PAYLOAD, options)

  t.equal(options.breakingSection, 'upgrade')
  t.equal(out.entries[0].section, 'upgrade')
  t.ok(
    options.sectionIds.includes(out.entries[0].section)
  , 'it lands in a rendered section'
  )
})

test('normalize() re-homes a refused omission into the configured section', async (t) => {
  const options = normalize(EXTRAS, {env: {}})
  const out = shape(result({
    omitted: [{hash: 'aaa1111', reason: 'trivial'}]
  }), PAYLOAD, options)

  t.equal(out.omitted.length, 0)
  t.equal(out.entries[0].section, 'upgrade')
})

test('fromCommit() honors the configured breaking section', async (t) => {
  const options = normalize(EXTRAS, {env: {}})
  t.equal(fromCommit(BREAKING, options).section, 'upgrade')
})

test('normalize() survives a null result', async (t) => {
  const out = shape(null, PAYLOAD, OPTIONS)

  t.same(out.entries, [])
  t.same(out.omitted, [])
  t.equal(out.missing.length, 2, 'every commit is still accounted for')
})

test('normalize() ignores an entry whose hashes are not a list', async (t) => {
  const out = shape(result({
    entries: [entry({hashes: 'bbb2222'}), entry({hashes: null})]
  }), PAYLOAD, OPTIONS)

  t.same(out.entries, [], 'a malformed claim claims nothing')
})

test('normalize() ignores a malformed omission', async (t) => {
  const malformed = result({omitted: [null, {reason: 'trivial'}]})
  const out = shape(malformed, PAYLOAD, OPTIONS)
  t.same(out.omitted, [])
})

test('sanitize() keeps the text of a link and drops its target', async (t) => {
  // Commit text from an outside contributor can steer what the model writes.
  t.equal(
    sanitize('Click [here](https://evil.example) ![pixel](https://t.example/p.png)', 0)
  , 'Click here pixel'
  )
  t.equal(sanitize('[a [b]](https://evil.example) ok', 0), 'a [b] ok', 'nested brackets')
  t.equal(sanitize('[![badge](https://img)](https://evil) x', 0), 'badge x', 'a linked image')
  t.equal(
    sanitize('See [docs](https://en.wikipedia.org/wiki/Foo_(bar)) now', 0)
  , 'See docs now'
  , 'a destination holding parentheses'
  )
  t.equal(
    sanitize('Set [agent.llm] and [x] (y), or `[x](y)`', 0)
  , 'Set [agent.llm] and [x] (y), or `[x](y)`'
  , 'brackets that are not a link, and code, stay as written'
  )
})

test('sanitize() escapes a tag so HTML shows as text', async (t) => {
  t.equal(
    sanitize('<img src=x onerror=alert(1)> and </b> and <!-- hidden -->', 0)
  , '&lt;img src=x onerror=alert(1)> and &lt;/b> and &lt;!-- hidden -->'
  )
  t.equal(sanitize('Links like <https://evil.example>', 0), 'Links like &lt;https://evil.example>')
  t.equal(
    sanitize('Keeps a < b, a <= b and `Vec<String>`', 0)
  , 'Keeps a < b, a <= b and `Vec<String>`'
  , 'a comparison and code stay as written'
  )
})

test('normalize() writes no link the renderer did not build', async (t) => {
  const out = shape(result({
    entries: [entry({
      headline: 'Read the [migration guide](https://evil.example/login)'
    , details: ['Track it <img src="https://t.example/p.png"> here.']
    })]
  }), PAYLOAD, OPTIONS)

  t.equal(out.entries[0].headline, 'Read the migration guide.')
  t.equal(out.entries[0].details[0], 'Track it &lt;img src="https://t.example/p.png"> here.')
})

test('sanitize() treats null and undefined as empty', async (t) => {
  t.equal(sanitize(null, 20), '')
  t.equal(sanitize(undefined, 20), '')
  t.equal(sanitize(42, 20), '42', 'a non-string is coerced')
})

test('clamp() hard-cuts a long unbroken token', async (t) => {
  t.equal(clamp('aaaaaaaaaaaaaaaaaaaa', 5), 'aaaaa', 'no word boundary to fall back on')
})

test('fromCommit() files a commit with no type in the fallback section', async (t) => {
  t.equal(fromCommit(commit({type: undefined}), OPTIONS).section, OPTIONS.fallbackSection)
})

test('scopeOf() treats null and undefined as empty', async (t) => {
  t.equal(scopeOf(null, 32), '')
  t.equal(scopeOf(undefined, 32), '')
})

test('clamp() hard-cuts when the only word boundary is too early', async (t) => {
  t.equal(clamp('a bbbbbbbbbbbbbbbbbb', 10), 'a bbbbbbbb')
})

test('clamp() passes text through when there is no limit', async (t) => {
  t.equal(clamp('unbounded text', 0), 'unbounded text')
})

const KEEPACHANGELOG = normalize(EXTRAS, {env: {}})

function change(hash, type, subject) {
  return {
    hash
  , fullHash: `${hash}000`
  , subject
  , type
  , scope: 'cli'
  , breaking: false
  , references: []
  }
}

const SPLIT_PAYLOAD = [
  change('f1', 'feat', 'show cached tokens in the status line')
, change('x1', 'fix', 'stop replay clobbering the ledger')
, change('x2', 'fix', 'count the cached share on resume')
]

test('normalize() keeps a derived entry in the action section', async (t) => {
  // Regression: an upgrade note restating a change described above it names hashes
  // an entry already claimed. The one-claim rail used to delete it outright.
  const out = shape(result({
    entries: [
      entry({hashes: ['f1'], section: 'added', headline: 'prompt caching'})
    , entry({hashes: ['f1', 'f1'], section: 'upgrade', headline: 'enable it per agent'})
    ]
  }), SPLIT_PAYLOAD, KEEPACHANGELOG)

  t.same(
    out.entries.map((e) => { return [e.section, e.headline] })
  , [['added', 'Prompt caching.'], ['upgrade', 'Enable it per agent.']]
  , 'the same commit is described once and acted on once'
  )
  t.same(out.entries[1].hashes, ['f1'], 'a repeated hash counts once inside the entry')
})

test('normalize() exempts an action entry from the section floor', async (t) => {
  // An upgrade note about a feature is filed by what it asks of the reader. The
  // floor would read the `feat` and drag it into "Added".
  const out = shape(result({
    entries: [entry({hashes: ['f1'], section: 'upgrade', headline: 'turn it on'})]
  }), SPLIT_PAYLOAD, KEEPACHANGELOG)

  t.equal(out.entries[0].section, 'upgrade')
})

test('normalize() accounts for a commit carried only by an action entry', async (t) => {
  const out = shape(result({
    entries: [entry({hashes: ['f1'], section: 'upgrade', headline: 'turn it on'})]
  }), SPLIT_PAYLOAD, KEEPACHANGELOG)

  t.same(
    out.missing.map((c) => { return c.hash })
  , ['x1', 'x2']
  , 'it is not rendered a second time beside the note about it'
  )
})

test('normalize() ignores an action entry naming nothing real', async (t) => {
  const unknown = shape(result({
    entries: [entry({hashes: ['nope'], section: 'upgrade'})]
  }), SPLIT_PAYLOAD, KEEPACHANGELOG)
  t.equal(unknown.entries.length, 0, 'a hash in no release is not an entry')

  const malformed = shape(result({
    entries: [entry({hashes: 'f1', section: 'upgrade'})]
  }), SPLIT_PAYLOAD, KEEPACHANGELOG)
  t.equal(malformed.entries.length, 0, 'neither is a hashes field that is not a list')
})

test('normalize() treats no section as derived when none is reserved', async (t) => {
  // With no action section, "breaking" is an ordinary section and its entries
  // claim their commits like any other.
  const out = shape(result({
    entries: [
      entry({hashes: ['bbb2222'], section: 'breaking', headline: 'first'})
    , entry({hashes: ['bbb2222'], section: 'breaking', headline: 'second'})
    ]
  }), PAYLOAD, OPTIONS)

  t.equal(out.entries.length, 1, 'the second claim is refused')
  t.equal(out.entries[0].headline, 'First.')
})

test('normalize() keeps the section the agent chose for a lone commit', async (t) => {
  // The commit type cannot second-guess the agent here. An earlier version floored
  // the section by type, which pulled `refactor(x): remove the journal` out of
  // Removed and emptied the section. splitSections() is what stops a change being
  // hidden; this is judgement the agent is better placed to make.
  const removal = change('r1', 'refactor', 'remove the prompt journal')
  const out = shape(result({
    entries: [entry({hashes: ['r1'], section: 'removed'})]
  }), [removal], KEEPACHANGELOG)

  t.equal(out.entries[0].section, 'removed', 'a refactor that removes is a removal')
})

test('normalize() sets no floor from a type the table does not map', async (t) => {
  const payload = [change('u1', 'bogus', 'do something odd')]

  const known = shape(result({
    entries: [entry({hashes: ['u1'], section: 'contributors'})]
  }), payload, KEEPACHANGELOG)
  t.equal(known.entries[0].section, 'contributors', 'an unmapped type carries no signal')

  const unknown = shape(result({
    entries: [entry({hashes: ['u1'], section: 'not-a-section'})]
  }), payload, KEEPACHANGELOG)
  t.equal(
    unknown.entries[0].section
  , KEEPACHANGELOG.fallbackSection
  , 'a bogus section still falls back'
  )
})

test('normalize() claims a commit named by its full hash', async (t) => {
  const out = shape(result({
    entries: [entry({hashes: ['bbb2222000']})]
  }), PAYLOAD, OPTIONS)

  t.same(out.entries[0].hashes, ['bbb2222'], 'the long form resolves to the short key')
  t.same(
    out.missing.map((c) => { return c.hash })
  , ['aaa1111']
  , 'and is not left missing'
  )
})

test('normalize() honours an omission named by its full hash', async (t) => {
  const out = shape(result({
    entries: []
  , omitted: [{hash: 'bbb2222000', reason: 'trivial'}]
  }), PAYLOAD, OPTIONS)

  t.same(out.omitted.map((o) => { return o.hash }), ['bbb2222'])
})

test('normalize() ignores an omission for an already-claimed commit', async (t) => {
  const out = shape(result({
    entries: [entry({hashes: ['bbb2222'], headline: 'described'})]
  , omitted: [{hash: 'bbb2222', reason: 'trivial'}]
  }), PAYLOAD, OPTIONS)

  t.equal(out.entries[0].headline, 'Described.', 'the entry keeps it')
  t.same(out.omitted, [], 'it cannot also be dropped')
})

test('normalize() keeps an entry whole whatever its commits\' types say', async (t) => {
  // The section is the agent's call. Deriving it from commit types split entries
  // whose commits disagreed, and only one half could keep the prose -- the other
  // rendered from a bare commit subject. `feat(ci): …` is contributor work whatever
  // its type says.
  const out = shape(result({
    entries: [entry({
      hashes: ['f1', 'x1', 'x2']
    , section: 'contributors'
    , headline: 'snapshot machinery'
    , details: ['It runs daily.']
    })]
  }), SPLIT_PAYLOAD, KEEPACHANGELOG)

  t.equal(out.entries.length, 1, 'one entry, not three')
  t.equal(out.entries[0].section, 'contributors')
  t.same(out.entries[0].hashes, ['f1', 'x1', 'x2'])
  t.same(out.entries[0].details, ['It runs daily.'], 'and it keeps the prose')
})

test('normalize() rides supporting commits with their entry', async (t) => {
  const payload = [...SPLIT_PAYLOAD, change('c1', 'chore', 'tidy up after it')]
  const out = shape(result({
    entries: [entry({
      hashes: ['f1']
    , supporting: ['c1']
    , section: 'added'
    , headline: 'a feature'
    })]
  }), payload, KEEPACHANGELOG)

  t.equal(out.entries.length, 1)
  t.same(out.entries[0].hashes, ['f1', 'c1'], 'both link to the one entry')
})

test('normalize() gives a supporting commit to only one entry', async (t) => {
  const out = shape(result({
    entries: [
      entry({hashes: ['f1'], supporting: ['x1'], section: 'added', headline: 'first'})
    , entry({hashes: ['x2'], supporting: ['x1'], section: 'fixed', headline: 'second'})
    ]
  }), SPLIT_PAYLOAD, KEEPACHANGELOG)

  t.same(out.entries[0].hashes, ['f1', 'x1'], 'the first claim wins')
  t.same(out.entries[1].hashes, ['x2'], 'the second gets nothing extra')
})

test('normalize() grades importance and defaults an unknown value', async (t) => {
  const out = shape(result({
    entries: [
      entry({hashes: ['bbb2222'], importance: 'critical'})
    , entry({hashes: ['aaa1111'], section: 'breaking', importance: 'nonsense'})
    ]
  }), PAYLOAD, OPTIONS)

  t.equal(out.entries[0].importance, 'critical')
  t.equal(
    out.entries[1].importance
  , 'high'
  , 'unknown falls back to medium, then the breaking floor lifts it'
  )
})

test('importanceOf() floors a breaking change but never lowers it', async (t) => {
  t.equal(importanceOf('low', true), 'high', 'a breaking change is never low')
  t.equal(importanceOf('medium', true), 'high')
  t.equal(importanceOf('critical', true), 'critical', 'the floor does not demote')
  t.equal(importanceOf('low', false), 'low', 'non-breaking entries keep their grade')
  t.equal(importanceOf('bogus', false), 'medium', 'unknown grades read as medium')
})

test('normalize() keeps a detail that overshoots its target whole', async (t) => {
  // Regression: `detail` used to be cut at the limit, which lost the end of the
  // thought on the overshoots a model routinely produces. Here that cost the
  // reader what the fallback actually does.
  const options = normalize({limits: {detail: 60}}, {env: {}})
  const long = 'Each agent gets a deterministic UUIDv5 derived from a config seed and '
    + 'an environment seed, falling back to a per-process random UUID.'

  const out = shape(result({
    entries: [entry({details: [long]})]
  }), PAYLOAD, options)

  t.equal(out.entries[0].details[0], long, 'no cut, no ellipsis')
})

test('normalize() bounds an entry by sentence count, not sentence length', async (t) => {
  const options = normalize({limits: {detail: 10, maxDetails: 2}}, {env: {}})
  const details = ['One well past ten characters.', 'Two as well.', 'Three as well.']

  const out = shape(result({
    entries: [entry({details})]
  }), PAYLOAD, options)

  t.same(out.entries[0].details, details.slice(0, 2), 'the third sentence is dropped')
})

test('normalize() strips emphasis the model emits but keeps globs', async (t) => {
  const out = shape(result({
    entries: [entry({
      headline: '**Already bold**'
    , details: ['Only `hotfix/*` may target it.']
    })]
  }), PAYLOAD, OPTIONS)

  t.equal(out.entries[0].headline, 'Already bold.', 'the renderer owns the bold')
  t.equal(out.entries[0].details[0], 'Only `hotfix/*` may target it.')
})

test('normalize() keeps `**` inside a code span', async (t) => {
  const out = shape(result({
    entries: [entry({
      headline: 'Excludes now take `src/**/*.js`'
    , details: ['**Bold** outside and `a/**` inside, then **more**.']
    })]
  }), PAYLOAD, OPTIONS)

  t.equal(out.entries[0].headline, 'Excludes now take `src/**/*.js`.')
  t.equal(out.entries[0].details[0], 'Bold outside and `a/**` inside, then more.')
})

test('normalize() keeps a sign or comparison that opens a sentence', async (t) => {
  const out = shape(result({
    entries: [entry({
      headline: '> 2 GB uploads resume'
    , details: ['+ 3 retries by default', '- 1 is the new sentinel', '* 2 workers']
    })]
  }), PAYLOAD, OPTIONS)

  t.equal(out.entries[0].headline, '> 2 GB uploads resume.')
  t.same(out.entries[0].details, [
    '+ 3 retries by default.'
  , '- 1 is the new sentinel.'
  , '* 2 workers.'
  ])
})

test('bounded() leaves a fitting sentence alone', async (t) => {
  t.equal(bounded('Fits fine', 120), 'Fits fine.')
  t.equal(bounded('', 120), '')
  t.equal(bounded(null, 120), '')
})

test('normalize() renders a breaking change once when sections collide', async (t) => {
  // Under keepachangelog the breaking section and the action section are both
  // "upgrade", and the prompt asks for the same change twice on purpose.
  const breaking = {
    hash: 'b1'
  , fullHash: 'b10'
  , subject: 'drop the v1 endpoint'
  , type: 'feat'
  , scope: 'api'
  , breaking: true
  , references: []
  }
  const out = shape(result({
    entries: [
      entry({hashes: ['b1'], section: 'changed', headline: 'the endpoint is gone'})
    , entry({hashes: ['b1'], section: 'upgrade', headline: 'move off the v1 endpoint'})
    ]
  }), [breaking], KEEPACHANGELOG)

  t.equal(out.entries.length, 1, 'one bullet, not two in the same section')
  t.equal(out.entries[0].section, 'upgrade')
})

test('normalize() names a commit whose headline sanitizes to nothing', async (t) => {
  const bare = {
    hash: 'e1', fullHash: 'e10', subject: '**', type: 'fix', scope: ''
  , breaking: false, references: []
  }
  const out = shape(result({
    entries: [entry({hashes: ['e1'], headline: '\u{1F389}', details: []})]
  }), [bare], OPTIONS)

  t.equal(out.entries[0].headline, 'Commit e1.', 'rather than rendering a bare bullet')
})

test('normalize() records an entry the one-claim rail deletes', async (t) => {
  // Two runs in a row submitted 30 entries and rendered 29. The commit stayed
  // accounted for, so nothing failed -- the prose just never reached anyone.
  const out = shape(result({
    entries: [
      entry({hashes: ['aaa1111'], headline: 'First claim'})
    , entry({hashes: ['aaa1111'], supporting: ['bbb2222'], headline: 'Lost'})
    ]
  }), PAYLOAD, OPTIONS)

  t.equal(out.entries.length, 1, 'the duplicate does not render')
  t.same(out.dropped.map((drop) => { return drop.reason }), ['commits-already-claimed'])
  t.match(out.dropped[0].headline, /Lost/, 'carrying the prose that was lost')
  t.same(out.dropped[0].hashes, ['aaa1111', 'bbb2222'])
})

test('normalize() records an entry that claimed no commits at all', async (t) => {
  const out = shape(result({
    entries: [
      entry({hashes: ['bbb2222'], headline: 'Real'})
    , entry({hashes: [], headline: 'Named nothing'})
    ]
  }), PAYLOAD, OPTIONS)

  t.same(out.dropped.map((drop) => { return drop.reason }), ['no-commits'])
  t.same(out.dropped[0].hashes, [], 'and says it named none')
})

// The default preset restates a breaking change rather than moving it, the way
// Angular lists a commit under its type and its note under BREAKING CHANGES.
const RESTATE = normalize({}, {env: {}})
const NOTED = {
  ...BREAKING
, breakingNotes: ['Sessions expire after 15 minutes.', 'Tokens rotate.']
}

test('normalize() leaves a breaking entry in the section the agent chose', async (t) => {
  const out = shape(result({
    entries: [
      entry({hashes: ['aaa1111'], section: 'features', headline: 'shorter sessions'})
    , entry({hashes: ['aaa1111'], section: 'breaking', headline: 'sign in again'})
    ]
  , omitted: [{hash: 'bbb2222', reason: 'trivial'}]
  }), [NOTED, commit({})], RESTATE)

  t.same(out.entries.map((e) => { return [e.section, e.headline] }), [
    ['features', 'Shorter sessions.']
  , ['breaking', 'Sign in again.']
  ], 'the agent restated it, so nothing is added')
  t.equal(out.missing.length, 0)
})

test('normalize() restates a breaking commit from each of its notes', async (t) => {
  const out = shape(result({
    entries: [entry({hashes: ['aaa1111'], section: 'features', headline: 'shorter'})]
  , omitted: [{hash: 'bbb2222', reason: 'trivial'}]
  }), [NOTED, commit({})], RESTATE)

  const restated = out.entries.filter((e) => { return e.section === 'breaking' })
  t.same(restated.map((e) => { return e.headline }), [
    'Sessions expire after 15 minutes.'
  , 'Tokens rotate.'
  ])
  t.equal(restated[0].scope, 'api-auth')
  t.equal(restated[0].confidence, 'low')
})

test('normalize() restates a `!` commit from its subject', async (t) => {
  const out = shape(result({
    entries: [entry({hashes: ['aaa1111'], section: 'features'})]
  , omitted: [{hash: 'bbb2222', reason: 'trivial'}]
  }), PAYLOAD, RESTATE)

  const restated = out.entries.filter((e) => { return e.section === 'breaking' })
  t.same(restated.map((e) => { return e.headline }), ['Shorten session lifetime.'])
})

test('normalize() restates an omitted breaking commit only once', async (t) => {
  const out = shape(result({
    entries: [entry({})]
  , omitted: [{hash: 'aaa1111', reason: 'no-audience-impact'}]
  }), PAYLOAD, RESTATE)

  t.equal(out.omitted.length, 0, 'the omission is refused')
  t.same(out.entries.map((e) => { return e.section }), ['fixes', 'breaking'])
})

test('normalize() drops a restatement of a commit that is not breaking', async (t) => {
  const out = shape(result({
    entries: [entry({section: 'breaking', headline: 'not really'})]
  , omitted: [{hash: 'aaa1111', reason: 'trivial'}]
  }), PAYLOAD, RESTATE)

  t.same(out.dropped.map((d) => { return d.reason }), ['not-breaking'])
  t.same(out.missing.map((c) => { return c.hash }), ['bbb2222'])
})

test('normalize() drops an entry the table has no section for', async (t) => {
  const out = shape(result({
    entries: [entry({section: 'chores'})]
  , omitted: [{hash: 'aaa1111', reason: 'trivial'}]
  }), PAYLOAD, RESTATE)

  t.same(out.dropped.map((d) => { return d.reason }), ['no-section'])
  const missing = out.missing.map((c) => { return c.hash })
  t.same(missing, ['bbb2222'], 'left for the forgotten path')
})

test('fromCommit() files a breaking commit by type when restating', async (t) => {
  t.equal(fromCommit(BREAKING, RESTATE).section, 'features')
  const chore = fromCommit(commit({type: 'chore'}), RESTATE)
  t.equal(chore, null, 'Angular has no home for it')
})

// Strict keepachangelog has no breaking section, so a breaking entry stays where
// the agent filed it and only one with no entry is filed in Changed.
const STRICT = normalize({preset: 'keepachangelog'}, {env: {}})

test('normalize() leaves a strict breaking entry where it was filed', async (t) => {
  const out = shape(result({
    entries: [entry({hashes: ['aaa1111'], section: 'removed', headline: 'drop v1'})]
  , omitted: [{hash: 'bbb2222', reason: 'trivial'}]
  }), PAYLOAD, STRICT)

  t.same(out.entries.map((e) => { return e.section }), ['removed'])
})

test('normalize() files an omitted breaking commit in Changed', async (t) => {
  const out = shape(result({
    entries: [entry({section: 'fixed'})]
  , omitted: [{hash: 'aaa1111', reason: 'no-audience-impact'}]
  }), PAYLOAD, STRICT)

  t.equal(out.omitted.length, 0, 'the omission is refused')
  t.same(out.entries.map((e) => { return e.section }), ['fixed', 'changed'])
  t.equal(fromCommit(BREAKING, STRICT).section, 'changed', 'and so is a forgotten one')
})

