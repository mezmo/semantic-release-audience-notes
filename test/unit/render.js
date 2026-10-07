import {test} from 'tap'

import {describe} from '../../lib/repository.js'
import {normalize} from '../../lib/options.js'
import {render} from '../../lib/render.js'

// Keep a Changelog with both opt-in sections, the layout Upgrade notes tests need.
const EXTRAS = {preset: 'keepachangelog', extraSections: ['upgrade', 'contributors']}

const REPOSITORY = describe('https://github.com/mezmo/repo.git')
const CONTEXT = {nextRelease: {version: '3.2.0'}}

function body(...entries) {
  return {summary: '', entries, omitted: [], missing: []}
}

function entry(overrides) {
  return {
    hashes: ['aaa1111']
  , commits: [{hash: 'aaa1111', fullHash: 'aaa1111000'}]
  , section: 'fixes'
  , scope: 'core'
  , headline: 'Something changed.'
  , details: []
  , importance: 'medium'
  , confidence: 'high'
  , references: []
  , breaking: false
  , ...overrides
  }
}

test('render() emits sections in the fixed order', async (t) => {
  const options = normalize({}, {env: {}})
  const notes = render({
    summary: ''
  , entries: [
      entry({section: 'reverts', headline: 'A revert.'})
    , entry({section: 'breaking', headline: 'A break.'})
    , entry({section: 'fixes', headline: 'A fix.'})
    , entry({section: 'features', headline: 'A feature.'})
    ]
  , missing: []
  }, CONTEXT, options, REPOSITORY)

  const order = notes.split('\n')
    .filter((line) => { return line.startsWith('### ') })
    .map((line) => { return line.replace('### ', '') })

  t.same(order, ['Bug Fixes', 'Features', 'Reverts', 'BREAKING CHANGES'])
})

test('render() sorts by scope and puts unscoped entries last', async (t) => {
  const options = normalize({includeCommitLinks: false}, {env: {}})
  const notes = render({
    summary: ''
  , entries: [
      entry({scope: '', headline: 'No scope.'})
    , entry({scope: 'zeta', headline: 'Zeta.'})
    , entry({scope: 'alpha', headline: 'Alpha.'})
    ]
  , missing: []
  }, CONTEXT, options, REPOSITORY)

  const bullets = notes.split('\n').filter((line) => { return line.startsWith('* ') })
  t.match(bullets[0], /alpha/)
  t.match(bullets[1], /zeta/)
  t.match(bullets[2], /No scope/)
})

test('render() preserves commit order when entryOrder is "commit"', async (t) => {
  const options = normalize({entryOrder: 'commit', includeCommitLinks: false}, {env: {}})
  const notes = render({
    summary: ''
  , entries: [
      entry({scope: 'zeta', headline: 'Zeta.'})
    , entry({scope: 'alpha', headline: 'Alpha.'})
    ]
  , missing: []
  }, CONTEXT, options, REPOSITORY)

  const bullets = notes.split('\n').filter((line) => { return line.startsWith('* ') })
  t.match(bullets[0], /zeta/, 'model order is preserved')
})

test('render() links commits with the full hash and short display text', async (t) => {
  const options = normalize({}, {env: {}})
  const notes = render(body(entry({})), CONTEXT, options, REPOSITORY)
  const link = '([aaa1111](https://github.com/mezmo/repo/commit/aaa1111000))'
  t.ok(notes.includes(link), 'links use the full hash with short display text')
})

test('render() degrades to a bare hash when there is no repository url', async (t) => {
  const options = normalize({}, {env: {}})
  const notes = render(body(entry({})), CONTEXT, options, describe(''))
  t.match(notes, /^\* \*\*core:\*\* Something changed aaa1111$/m)
  t.notMatch(notes, /\]\(/)
})

test('render() writes one line per entry, closing its references', async (t) => {
  const options = normalize({}, {env: {}})
  const notes = render({
    summary: ''
  , entries: [entry({
      details: ['Clients sign out.']
    , references: ['LOG-1', '#2', 'mezmo/rig#3']
    })]
  , missing: []
  }, CONTEXT, options, REPOSITORY)

  t.match(notes, '* **core:** Something changed '
    + '([aaa1111](https://github.com/mezmo/repo/commit/aaa1111000)), closes LOG-1 '
    + '[#2](https://github.com/mezmo/repo/issues/2) '
    + '[mezmo/rig#3](https://github.com/mezmo/rig/issues/3)\n')
  t.notMatch(notes, /Clients sign out/, 'details are not rendered')
})

test('render() leaves references and hashes bare with links off', async (t) => {
  const options = normalize({linkReferences: false}, {env: {}})
  const notes = render(body(entry({
    commits: [{hash: 'aaa1111'}, {hash: 'bbb2222'}]
  , references: ['#2']
  })), CONTEXT, options, REPOSITORY)

  t.match(notes, '* **core:** Something changed aaa1111, bbb2222, closes #2\n')
})

test('render() links every commit of a grouped entry in one parens', async (t) => {
  const options = normalize({}, {env: {}})
  const notes = render(body(entry({
    commits: [{hash: 'aaa1111', fullHash: 'aaa1'}, {hash: 'bbb2222', fullHash: 'bbb2'}]
  })), CONTEXT, options, REPOSITORY)

  t.match(notes, '([aaa1111](https://github.com/mezmo/repo/commit/aaa1), '
    + '[bbb2222](https://github.com/mezmo/repo/commit/bbb2))')
})

test('render() lays out a release exactly as Angular does', async (t) => {
  const options = normalize({}, {env: {}})
  const notes = render(body(
    entry({section: 'features', scope: '', headline: 'Adds a thing.', commits: []})
  , entry({section: 'fixes', headline: 'Fixes a thing.', commits: []})
  , entry({section: 'breaking', headline: 'Sign in again.', commits: []})
  ), {nextRelease: {version: '2.0.0'}}, options, describe(''))

  t.equal(notes.replace(/\d{4}-\d{2}-\d{2}/, 'DATE'), [
    '# 2.0.0 (DATE)'
  , ''
  , ''
  , '### Bug Fixes'
  , ''
  , '* **core:** Fixes a thing'
  , ''
  , ''
  , '### Features'
  , ''
  , '* Adds a thing'
  , ''
  , ''
  , '### BREAKING CHANGES'
  , ''
  , '* **core:** Sign in again.'
  , ''
  ].join('\n'), 'the note keeps its period and the commit lines drop theirs')
})

test('render() renders a breaking entry as a commit line when it is moved', async (t) => {
  const options = normalize({actionSection: ''}, {env: {}})
  const notes = render(
    body(entry({section: 'breaking', headline: 'Sign in again.'}))
  , CONTEXT
  , options
  , REPOSITORY
  )

  t.match(notes, /^\* \*\*core:\*\* Sign in again \(\[aaa1111\]/m)
})

test('render() picks the heading level from the version', async (t) => {
  const options = normalize({}, {env: {}})
  function at(version) {
    return render(body(entry({})), {nextRelease: {version}}, options, REPOSITORY)
  }
  const minor = at('3.2.0')
  const patch = at('3.2.1')

  t.match(minor, /^# 3\.2\.0 /)
  t.match(patch, /^## 3\.2\.1 /)
  t.match(patch, /\n### Bug Fixes\n/, 'sections stay at ### either way')
})

test('render() links the version to a compare view of the two tags', async (t) => {
  const context = {
    lastRelease: {gitTag: 'v3.1.0'}
  , nextRelease: {version: '3.2.0', gitTag: 'v3.2.0'}
  }
  const linked = render(body(entry({})), context, normalize({}, {env: {}}), REPOSITORY)
  const plain = render(
    body(entry({}))
  , context
  , normalize({linkCompare: false}, {env: {}})
  , REPOSITORY
  )
  const heads = render(
    body(entry({}))
  , {lastRelease: {gitHead: 'abc'}, nextRelease: {version: '3.2.0', gitHead: 'def'}}
  , normalize({}, {env: {}})
  , REPOSITORY
  )

  t.ok(linked.startsWith(
    '# [3.2.0](https://github.com/mezmo/repo/compare/v3.1.0...v3.2.0) ('
  ))
  t.match(plain, /^# 3\.2\.0 /)
  t.match(heads, /compare\/abc\.\.\.def\)/, 'heads stand in for missing tags')
})

test('render() annotates confidence only when enabled and below high', async (t) => {
  const off = normalize({includeCommitLinks: false}, {env: {}})
  const on = normalize({includeConfidence: true, includeCommitLinks: false}, {env: {}})
  const lowEntry = body(entry({confidence: 'low'}))

  t.notMatch(render(lowEntry, CONTEXT, off, REPOSITORY), /confidence/)
  t.match(render(lowEntry, CONTEXT, on, REPOSITORY), /_\(low confidence\)_/)
  t.notMatch(
    render(body(entry({confidence: 'high'})), CONTEXT, on, REPOSITORY)
  , /confidence/
  , 'high confidence is the norm and stays unannotated'
  )
})

test('render() honors the configured heading level and title template', async (t) => {
  const options = normalize({headingLevel: 1, title: 'Release {version}'}, {env: {}})
  const notes = render(body(entry({})), CONTEXT, options, REPOSITORY)
  t.match(notes, /^# Release 3\.2\.0\n/)
  t.match(notes, /\n## Bug Fixes\n/)
})

test('render() in prose style ends with one newline', async (t) => {
  const options = normalize({preset: 'keepachangelog'}, {env: {}})
  const hidden = {summary: 'Hidden.', entries: [entry({})], omitted: [], missing: []}
  const notes = render(hidden, CONTEXT, options, REPOSITORY)
  t.notMatch(notes, /Hidden/)
  t.match(notes, /[^\n]\n$/, 'exactly one trailing newline')
  t.notMatch(notes, /\n\n\n/, 'no runs of blank lines')
})

test('render() is byte-stable for the same input', async (t) => {
  const options = normalize({}, {env: {}})
  const stable = {
    summary: 'Stable.'
  , entries: [entry({scope: 'zeta'}), entry({scope: 'alpha'})]
  , omitted: []
  , missing: []
  }
  t.equal(
    render(stable, CONTEXT, options, REPOSITORY)
  , render(stable, CONTEXT, options, REPOSITORY)
  )
})

test('render() in prose style joins the headline and details into one', async (t) => {
  const options = normalize({preset: 'keepachangelog'}, {env: {}})
  const notes = render(body(entry({
    section: 'added'
  , scope: ''
  , headline: 'Prompt caching for Anthropic and Bedrock.'
  , details: ['Set `prompt_caching = true` under `[agent.llm]`.', 'It is opt-in.']
  , references: ['#630']
  })), CONTEXT, options, REPOSITORY)

  const bullets = notes.split('\n').filter((line) => { return line.startsWith('- ') })
  t.equal(bullets.length, 1, 'detail sentences do not become sub-bullets')
  t.equal(
    bullets[0]
  , '- **Prompt caching for Anthropic and Bedrock.** Set `prompt_caching = true` '
      + 'under `[agent.llm]`. It is opt-in. (#630)'
  )
})

test('render() in prose style omits a trailer when there is no reference', async (t) => {
  const options = normalize({preset: 'keepachangelog'}, {env: {}})
  const notes = render(body(entry({
    section: 'added', scope: '', headline: 'A thing.', details: [], references: []
  })), CONTEXT, options, REPOSITORY)

  t.match(notes, /- \*\*A thing\.\*\*$/m, 'no commit link under this preset')
})

test('render() puts extra sections after the spec ones', async (t) => {
  const options = normalize(EXTRAS, {env: {}})
  const notes = render({
    summary: ''
  , entries: [
      entry({section: 'upgrade', scope: '', headline: 'Upgrade thing.'})
    , entry({section: 'added', scope: '', headline: 'Added thing.'})
    , entry({section: 'fixed', scope: '', headline: 'Fixed thing.'})
    ]
  , omitted: []
  , missing: []
  }, CONTEXT, options, REPOSITORY)

  const headings = notes.split('\n')
    .filter((line) => { return line.startsWith('### ') })
    .map((line) => { return line.replace('### ', '') })

  t.same(headings, ['Added', 'Fixed', 'Upgrade notes'])
})

test('render() never drops an entry whose section is not in the table', async (t) => {
  const options = normalize(EXTRAS, {env: {}})
  const notes = render(
    body(entry({section: 'not-a-real-section', headline: 'Must still appear.'}))
  , CONTEXT
  , options
  , REPOSITORY
  )

  t.match(notes, /Must still appear\./, 'it is re-homed rather than silently lost')
  t.match(notes, /### For contributors/)
})

test('render() breaks a scope tie on the headline', async (t) => {
  const options = normalize({includeCommitLinks: false}, {env: {}})
  const notes = render(
    body(
      entry({scope: 'core', headline: 'Zebra last.'})
    , entry({scope: 'core', headline: 'Apple first.'})
    )
  , CONTEXT
  , options
  , REPOSITORY
  )

  const bullets = notes.split('\n').filter((line) => { return line.startsWith('* ') })
  t.match(bullets[0], /Apple first/)
  t.match(bullets[1], /Zebra last/)
})

test('render() omits links in the omitted section when links are off', async (t) => {
  const options = normalize({includeOmitted: true, includeCommitLinks: false}, {env: {}})
  const notes = render({
    summary: ''
  , entries: []
  , omitted: [{hash: 'c3', fullHash: 'c3f', subject: 'Bumped a dep.', reason: 'trivial'}]
  , missing: []
  }, CONTEXT, options, REPOSITORY)

  t.match(notes, /\* Bumped a dep c3 _\(trivial\)_/)
  t.notMatch(notes, /\]\(http/)
})

test('render() links omitted commits when links are on', async (t) => {
  const options = normalize({includeOmitted: true}, {env: {}})
  const notes = render({
    summary: ''
  , entries: []
  , omitted: [{hash: 'c3', fullHash: 'c3f', subject: 'Bumped a dep.', reason: 'trivial'}]
  , missing: []
  }, CONTEXT, options, REPOSITORY)

  t.match(notes, '### Also in this release\n\n'
    + '* Bumped a dep ([c3](https://github.com/mezmo/repo/commit/c3f)) _(trivial)_')
})

test('render() in prose style lists omitted commits', async (t) => {
  const options = normalize({preset: 'keepachangelog', includeOmitted: true}, {env: {}})
  const notes = render({
    summary: ''
  , entries: []
  , omitted: [{hash: 'c3', fullHash: 'c3f', subject: 'Bumped a dep.', reason: 'trivial'}]
  , missing: []
  }, CONTEXT, options, REPOSITORY)

  t.match(notes, /- Bumped a dep\. _\(trivial\)_/)
})

test('render() falls back to the short hash when no full hash is present', async (t) => {
  const options = normalize({}, {env: {}})
  const notes = render(
    body(entry({commits: [{hash: 'short1'}]}))
  , CONTEXT
  , options
  , REPOSITORY
  )

  t.match(notes, /commit\/short1/)
})

test('render() emits no trailer for an entry covering no commits', async (t) => {
  const options = normalize({}, {env: {}})
  const notes = render(body(entry({commits: []})), CONTEXT, options, REPOSITORY)

  t.match(notes, /^\* \*\*core:\*\* Something changed$/m)
})

test('render() sorts a scoped entry ahead of an unscoped one either way', async (t) => {
  const options = normalize({includeCommitLinks: false}, {env: {}})
  const notes = render(
    body(
      entry({scope: 'zzz', headline: 'Scoped.'})
    , entry({scope: '', headline: 'Unscoped.'})
    )
  , CONTEXT
  , options
  , REPOSITORY
  )

  const bullets = notes.split('\n').filter((line) => { return line.startsWith('* ') })
  t.match(bullets[0], /Scoped/)
  t.match(bullets[1], /Unscoped/)
})

test('render() titles a release with no version', async (t) => {
  const options = normalize({}, {env: {}})
  const notes = render(body(entry({})), {}, options, REPOSITORY)
  t.match(notes, /^# \(\d{4}-\d{2}-\d{2}\)/)
})

test('render() in prose style can be given commit links', async (t) => {
  const options = normalize(
    {preset: 'keepachangelog', includeCommitLinks: true}
  , {env: {}}
  )
  const notes = render(
    body(entry({section: 'added', scope: '', headline: 'A thing.', references: []}))
  , CONTEXT
  , options
  , REPOSITORY
  )

  t.match(notes, /\]\(https:/, 'with no reference it falls back to the commit link')
})

test('render() orders entries by importance within a section', async (t) => {
  const config = {entryOrder: 'importance', includeCommitLinks: false}
  const options = normalize(config, {env: {}})
  const notes = render(
    body(
      entry({importance: 'low', scope: 'a', headline: 'Trivial.'})
    , entry({importance: 'critical', scope: 'z', headline: 'Data loss fixed.'})
    , entry({importance: 'medium', scope: 'm', headline: 'Noticeable.'})
    )
  , CONTEXT
  , options
  , REPOSITORY
  )

  const bullets = notes.split('\n').filter((line) => { return line.startsWith('* ') })
  t.match(
    bullets[0]
  , /Data loss fixed/
  , 'most important first, despite sorting last by scope'
  )
  t.match(bullets[1], /Noticeable/)
  t.match(bullets[2], /Trivial/)
})

test('render() breaks an importance tie on scope then headline', async (t) => {
  const config = {entryOrder: 'importance', includeCommitLinks: false}
  const options = normalize(config, {env: {}})
  const notes = render(
    body(
      entry({importance: 'high', scope: 'zeta', headline: 'Zeta thing.'})
    , entry({importance: 'high', scope: 'alpha', headline: 'Bravo thing.'})
    , entry({importance: 'high', scope: 'alpha', headline: 'Alpha thing.'})
    )
  , CONTEXT
  , options
  , REPOSITORY
  )

  const bullets = notes.split('\n').filter((line) => { return line.startsWith('* ') })
  t.match(bullets[0], /Alpha thing/)
  t.match(bullets[1], /Bravo thing/)
  t.match(bullets[2], /Zeta thing/)
})

test('render() can still sort by scope alone', async (t) => {
  const options = normalize({entryOrder: 'scope', includeCommitLinks: false}, {env: {}})
  const notes = render(
    body(
      entry({importance: 'low', scope: 'alpha', headline: 'Trivial.'})
    , entry({importance: 'critical', scope: 'zeta', headline: 'Urgent.'})
    )
  , CONTEXT
  , options
  , REPOSITORY
  )

  const bullets = notes.split('\n').filter((line) => { return line.startsWith('* ') })
  t.match(bullets[0], /Trivial/, 'importance is ignored under entryOrder: scope')
})

test('render() can annotate importance for tuning', async (t) => {
  const config = {includeImportance: true, includeCommitLinks: false}
  const options = normalize(config, {env: {}})
  const notes = render(
    body(entry({importance: 'critical', headline: 'Urgent.'}))
  , CONTEXT
  , options
  , REPOSITORY
  )

  t.match(notes, /_\(critical\)_/)
})

test('render() combines importance and confidence annotations', async (t) => {
  const options = normalize(
    {includeImportance: true, includeConfidence: true, includeCommitLinks: false}
  , {env: {}}
  )
  const notes = render(
    body(entry({importance: 'low', confidence: 'medium', headline: 'Unsure.'}))
  , CONTEXT
  , options
  , REPOSITORY
  )

  t.match(notes, /_\(low, medium confidence\)_/)
})

test('render() bolds the lead phrase in prose style', async (t) => {
  const options = normalize({preset: 'keepachangelog'}, {env: {}})
  const notes = render(body(entry({
    section: 'added'
  , scope: ''
  , headline: 'Prompt caching for Anthropic and Bedrock.'
  , details: ['Set `prompt_caching = true` under `[agent.llm]`.']
  , references: ['#630']
  })), CONTEXT, options, REPOSITORY)

  t.match(
    notes
  , /- \*\*Prompt caching for Anthropic and Bedrock\.\*\* Set `prompt_caching = true`/
  )
})

test('render() omits the bold wrapper when there is no headline', async (t) => {
  const options = normalize({preset: 'keepachangelog'}, {env: {}})
  const notes = render(body(entry({
    section: 'added', scope: '', headline: '', details: ['Just a detail.'], references: []
  })), CONTEXT, options, REPOSITORY)

  t.match(notes, /- Just a detail\./)
  t.notMatch(notes, /\*\*/)
})

test('render() follows the spec order under keepachangelog', async (t) => {
  const options = normalize({preset: 'keepachangelog'}, {env: {}})
  const notes = render({
    summary: ''
  , entries: [
      entry({section: 'changed', scope: '', headline: 'Changed thing.'})
    , entry({section: 'fixed', scope: '', headline: 'Fixed thing.'})
    ]
  , omitted: []
  , missing: []
  }, CONTEXT, options, REPOSITORY)

  const headings = notes.split('\n')
    .filter((line) => { return line.startsWith('### ') })
    .map((line) => { return line.replace('### ', '') })

  t.same(headings, ['Changed', 'Fixed'])
})

test('render() writes an unscoped breaking note without a scope', async (t) => {
  const options = normalize({}, {env: {}})
  const notes = render(
    body(entry({section: 'breaking', scope: '', headline: 'Sign in again.'}))
  , CONTEXT
  , options
  , REPOSITORY
  )

  t.match(notes, /^\* Sign in again\.$/m)
})

test('render() in prose style links omitted commits when asked', async (t) => {
  const config = {
    preset: 'keepachangelog', includeOmitted: true, includeCommitLinks: true
  }
  const options = normalize(config, {env: {}})
  const notes = render({
    summary: ''
  , entries: []
  , omitted: [{hash: 'c3', fullHash: 'c3f', subject: 'Bumped a dep.', reason: 'trivial'}]
  , missing: []
  }, CONTEXT, options, REPOSITORY)

  t.match(notes, '- Bumped a dep. ([`c3`](https://github.com/mezmo/repo/commit/c3f))')
})

test('render() in prose style degrades links without a repository', async (t) => {
  const config = {preset: 'keepachangelog', includeCommitLinks: true}
  const options = normalize(config, {env: {}})
  const added = {section: 'added', scope: '', headline: 'A thing.'}

  const bare = render(
    body(entry({...added, commits: [{hash: 'c3'}]}))
  , CONTEXT
  , options
  , describe('')
  )
  const none = render(body(entry({...added, commits: []})), CONTEXT, options, REPOSITORY)

  t.match(bare, '- **A thing.** (`c3`)')
  t.match(none, /^- \*\*A thing\.\*\*$/m, 'no commits, no trailer')
})

test('render() titles a keepachangelog release the way the spec does', async (t) => {
  const options = normalize({preset: 'keepachangelog'}, {env: {}})
  const context = {
    lastRelease: {gitTag: 'v1.1.1'}
  , nextRelease: {version: '1.1.2', gitTag: 'v1.1.2'}
  }
  const notes = render(body(entry({section: 'added'})), context, options, REPOSITORY)

  const compare = 'https://github.com/mezmo/repo/compare/v1.1.1...v1.1.2'
  t.ok(notes.startsWith(`## [1.1.2](${compare}) - `))
  t.match(notes, /^## .+ - \d{4}-\d{2}-\d{2}\n/)
})

