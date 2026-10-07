import {test} from 'tap'

import {readFile} from 'node:fs/promises'

import {AUDIENCE_PRESETS, DEFAULT_EXCLUDES, PRESETS} from '../../lib/constants.js'
import {
  KNOWN_OPTIONS
, misspelledOptions
, nearest
, normalize
, presetWarning
} from '../../lib/options.js'

test('normalize() rejects an actionSection outside the table', async (t) => {
  t.throws(
    () => { return normalize({actionSection: 'nowhere'}, {env: {}}) }
  , {code: 'EINVALIDSECTIONS'}
  )
})

test('normalize() resolves the action section from the preset', async (t) => {
  t.equal(
    normalize({}, {env: {}}).actionSection
  , 'breaking'
  , 'conventional restates breaking changes under their own heading'
  )
  t.equal(normalize({}, {env: {}}).breakingPlacement, 'restate')
  t.equal(
    normalize({actionSection: ''}, {env: {}}).breakingPlacement
  , 'move'
  , 'restating needs the action section to be the breaking one'
  )
})

test('normalize() keeps keepachangelog to the spec unless asked', async (t) => {
  const strict = normalize({preset: 'keepachangelog'}, {env: {}})
  t.same(
    strict.sections.map((section) => { return section.title })
  , ['Added', 'Changed', 'Deprecated', 'Removed', 'Fixed', 'Security']
  )
  t.equal(strict.actionSection, '', 'the spec has no reader-action section')
  t.equal(strict.breakingSection, 'changed')
  t.equal(strict.breakingPlacement, 'keep')
  t.equal(strict.fallbackSection, '')
  t.equal(strict.title, '{versionLink} - {date}')

  const config = {preset: 'keepachangelog', extraSections: ['upgrade']}
  const upgrade = normalize(config, {env: {}})
  t.equal(upgrade.actionSection, 'upgrade')
  t.equal(upgrade.breakingSection, 'upgrade')
  t.equal(upgrade.breakingPlacement, 'move')

  const both = normalize(
    {preset: 'keepachangelog', extraSections: ['contributors', 'upgrade']}
  , {env: {}}
  )
  t.same(both.sectionIds.slice(-2), ['upgrade', 'contributors'], 'in the preset\'s order')
  t.equal(both.fallbackSection, 'contributors')
  t.equal(both.typeSections.get('ci'), 'contributors')
})

test('normalize() sorts conventional extras in by title, as Angular does', async (t) => {
  const options = normalize({extraSections: ['ci', 'docs', 'chore']}, {env: {}})
  t.same(options.sections.map((section) => { return section.title }), [
    'Bug Fixes'
  , 'Continuous Integration'
  , 'Documentation'
  , 'Features'
  , 'Miscellaneous Chores'
  , 'Performance Improvements'
  , 'Reverts'
  , 'BREAKING CHANGES'
  ], 'breaking changes stay last')
  t.equal(options.typeSections.get('docs'), 'docs')
  t.equal(options.typeSections.get('chore'), 'chore')
  t.equal(options.fallbackSection, '', 'none of them becomes a catch-all')
})

test('normalize() rejects extra sections it cannot add', async (t) => {
  const env = {}
  t.throws(
    () => { return normalize({preset: 'keepachangelog', extraSections: ['x']}, {env}) }
  , {message: /Unknown `extraSections`: x/, details: /offers: upgrade, contributors/}
  )
  t.throws(
    () => { return normalize({extraSections: ['upgrade']}, {env}) }
  , {details: /offers: docs, style, refactor, test, build, ci, chore\./}
  , 'each preset offers its own'
  )
  t.throws(
    () => { return normalize({preset: 'keepachangelog', extraSections: ['docs']}, {env}) }
  , {details: /offers: upgrade, contributors\./}
  )
  t.throws(
    () => { return normalize({preset: 'keepachangelog', extraSections: 'x'}, {env: {}}) }
  , /must be an array/
  )
  t.throws(
    () => {
      return normalize({
        preset: 'keepachangelog', extraSections: ['upgrade'], sections: [{id: 'changed'}]
      }, {env: {}})
    }
  , /cannot join `sections`/
  )
  t.same(
    normalize({preset: 'keepachangelog', extraSections: []}, {env: {}}).sectionIds.length
  , 6
  , 'an empty list adds nothing'
  )
})

test('normalize() applies documented defaults', async (t) => {
  const options = normalize({}, {env: {}})

  t.equal(options.model, 'claude-opus-5-5')
  t.equal(options.effort, 'high')
  t.equal(options.audience.name, 'developers')
  t.equal(options.entryOrder, 'scope', 'Angular sorts by scope')
  t.same(
    options.sectionIds
  , ['fixes', 'features', 'performance', 'reverts', 'breaking']
  , 'Angular order, breaking last'
  )
  t.equal(options.fallbackSection, '', 'Angular has no home for other types')
  t.equal(options.headingLevel, 'auto')
  t.equal(options.title, '{versionLink} ({date})')
  t.equal(options.linkCompare, true)
  t.equal(options.agent.maxIterations, 40)
  t.equal(options.agent.maxToolCalls, 60)
})

test('normalize() expands a preset but keeps free text intact', async (t) => {
  const preset = normalize({audience: 'operators'}, {env: {}})
  t.ok(preset.audience.isPreset)
  t.match(preset.audience.description, /Operators and SREs/)

  const custom = normalize({audience: 'Nurses using the scheduling tablet'}, {env: {}})
  t.notOk(custom.audience.isPreset)
  t.equal(custom.audience.description, 'Nurses using the scheduling tablet')
})

test('normalize() fixes the read-tool caps and takes only an exclude list', async (t) => {
  const options = normalize({introspect: {}}, {env: {}})
  t.equal(options.introspect.maxFilesPerCommit, 25)
  t.equal(options.introspect.contextLines, 3)
  t.ok(options.introspect.exclude.includes('**/package-lock.json'))
  t.throws(
    () => { return normalize({introspect: {contextLines: 9}}, {env: {}}) }
  , /Unknown `introspect` keys: contextLines/
  )
})

test('normalize() takes only the two budgets under agent', async (t) => {
  t.throws(
    () => { return normalize({agent: {maxListBytes: 9}}, {env: {}}) }
  , /Unknown `agent` keys: maxListBytes/
  )
  t.equal(normalize({agent: {maxIterations: 9}}, {env: {}}).agent.maxListBytes, 131072)
})

test('normalize() gives the one-line style more headline room', async (t) => {
  t.equal(normalize({}, {env: {}}).limits.headline, 200)
  t.equal(normalize({preset: 'keepachangelog'}, {env: {}}).limits.headline, 120)
  t.equal(normalize({limits: {headline: 90}}, {env: {}}).limits.headline, 90)
})

test('misspelledOptions() names a near miss and nothing else', async (t) => {
  t.same(misspelledOptions({audiance: 'operators', branches: ['main']}), [
    {key: 'audiance', suggestion: 'audience'}
  ])
  t.same(misspelledOptions({Preset: 'angular'}), [{key: 'Preset', suggestion: 'preset'}])
  t.same(
    misspelledOptions({releaseRules: [], tagFormat: 'v{version}', ci: true})
  , []
  , 'other plugins and semantic-release keep their keys'
  )
  t.same(misspelledOptions(null), [])
})

test('documentation/OPTIONS.md lists the default excludes exactly', async (t) => {
  const file = new URL('../../documentation/OPTIONS.md', import.meta.url)
  const doc = await readFile(file, 'utf8')
  const block = doc.slice(doc.indexOf('## Default excludes'))
  const listed = [...block.slice(0, block.indexOf('```\n\n')).matchAll(/'([^']+)'/g)]
    .map((match) => { return match[1] })
  t.same(listed, DEFAULT_EXCLUDES)
})

// Id, title without its optional marker, commit types, and description.
const SECTION_ROW = new RegExp(
  String.raw`^\| \`([a-z]+)\` \| ([^|]+?)(?: \*\(optional\)\*)? \| ([^|]+) \| (.+) \|$`
, 'gm'
)

// The text from a heading up to the next heading of any level.
function section(doc, heading) {
  const start = doc.indexOf(`${heading}\n`)
  const next = doc.indexOf('\n#', start + heading.length)
  return doc.slice(start, next === -1 ? undefined : next)
}

test('documentation/OPTIONS.md gives each audience preset verbatim', async (t) => {
  const file = new URL('../../documentation/OPTIONS.md', import.meta.url)
  const doc = await readFile(file, 'utf8')
  const presets = section(doc, '## Audience presets')
  const rows = presets.matchAll(/^\| `([a-z-]+)`(?: \*\(default\)\*)? \| (.+) \|$/gm)
  const documented = new Map([...rows].map((row) => { return [row[1], row[2]] }))
  for (const [name, description] of AUDIENCE_PRESETS) {
    t.equal(documented.get(name), description, name)
  }
})

test('documentation/OPTIONS.md lists every preset section exactly', async (t) => {
  const file = new URL('../../documentation/OPTIONS.md', import.meta.url)
  const doc = await readFile(file, 'utf8')
  for (const [name, preset] of PRESETS) {
    const table = section(doc, `### \`${name}\``)
    const sections = [...preset.sections, ...preset.extraSections]
    t.same([...table.matchAll(SECTION_ROW)].map(([, id, title, list, description]) => {
      const types = list === '—' ? [] : list.split(', ').map((type) => {
        return type.slice(1, -1)
      })
      return {id, title, types, description}
    }), sections.map(({id, title, types, description}) => {
      return {id, title, types, description}
    }), name)
  }
})

test('KNOWN_OPTIONS matches documentation/OPTIONS.md', async (t) => {
  const file = new URL('../../documentation/OPTIONS.md', import.meta.url)
  const doc = await readFile(file, 'utf8')
  const tables = doc.slice(0, doc.indexOf('## Audience presets'))
  const rows = tables.matchAll(/^\| `([a-zA-Z]+)(?:\.\w+)?` \|/gm)
  const documented = new Set([...rows].map((row) => { return row[1] }))
  documented.add('linkReferences')
  t.same([...documented].sort(), [...KNOWN_OPTIONS].sort())
})

test('normalize() bounds the agent loop', async (t) => {
  const options = normalize({agent: {maxIterations: 5, maxToolCalls: 9}}, {env: {}})
  t.equal(options.agent.maxIterations, 5)
  t.equal(options.agent.maxToolCalls, 9)

  t.throws(() => {
    return normalize({agent: {maxToolCalls: 0}}, {env: {}})
  }, /maxToolCalls/)
  t.throws(() => { return normalize({agent: []}, {env: {}}) }, /agent/)
})

test('normalize() reads the api key from the configured env var', async (t) => {
  const env = {ANTHROPIC_API_KEY: 'from-default'}
  t.equal(normalize({}, {env}).apiKey, 'from-default')
  t.equal(
    normalize({apiKeyEnv: 'CUSTOM_KEY'}, {env: {CUSTOM_KEY: 'from-custom'}}).apiKey
  , 'from-custom'
  )
  t.equal(
    normalize({apiKey: 'committed'}, {env: {}}).apiKey
  , ''
  , 'a key in the config is never read'
  )
})

test('normalize() rejects invalid enum and range values', async (t) => {
  t.throws(() => { return normalize({effort: 'turbo'}, {env: {}}) }, /effort/)
  t.throws(() => { return normalize({audience: '   '}, {env: {}}) }, /audience/)
  t.throws(() => { return normalize({introspect: []}, {env: {}}) }, /introspect/)
})

test('normalize() maps extra commit types onto existing sections', async (t) => {
  const options = normalize({
    typeSections: {svc: 'features', lib: 'features', src: 'fixes'}
  }, {env: {}})

  t.equal(options.typeSections.get('svc'), 'features')
  t.equal(options.typeSections.get('src'), 'fixes')
  t.equal(options.typeSections.get('feat'), 'features', 'defaults survive the overlay')
})

test('normalize() accepts a replacement section table', async (t) => {
  const options = normalize({sections: [
    {id: 'breaking', title: 'Breaks', description: 'd'}
  , {id: 'services', title: 'Services', description: 'd', types: ['svc', 'lib']}
  ]}, {env: {}})

  t.same(options.sectionIds, ['breaking', 'services'])
  t.equal(options.typeSections.get('svc'), 'services')
  t.equal(options.typeSections.get('feat'), undefined, 'defaults are replaced')
  t.equal(options.fallbackSection, 'services', 'the last section absorbs unknown types')
})

test('normalize() rejects a table that cannot hold breaking changes', async (t) => {
  t.throws(
    () => { return normalize({sections: [{id: 'stuff', title: 'Stuff'}]}, {env: {}}) }
  , {code: 'EINVALIDSECTIONS', message: /"breaking"/}
  )
})

test('normalize() rejects duplicate section ids and unknown type targets', async (t) => {
  t.throws(() => {
    return normalize({sections: [{id: 'breaking'}, {id: 'breaking'}]}, {env: {}})
  }, /unique/)

  t.throws(() => {
    return normalize({typeSections: {svc: 'nope'}}, {env: {}})
  }, {code: 'EINVALIDSECTIONS', message: /unknown section/})

  t.throws(() => { return normalize({sections: []}, {env: {}}) }, /non-empty/)
  t.throws(() => {
    return normalize({sections: [{title: 'no id'}]}, {env: {}})
  }, /needs an/)
})

test('normalize() defaults to the conventional preset', async (t) => {
  const options = normalize({}, {env: {}})

  t.equal(options.entryStyle, 'conventional')
  t.equal(options.breakingSection, 'breaking')
  t.equal(options.includeCommitLinks, true)
  t.same(
    normalize({preset: 'conventional'}, {env: {}}).sectionIds
  , options.sectionIds
  , 'naming it explicitly changes nothing'
  )
})

test('normalize() still accepts the old "default" preset name', async (t) => {
  t.same(
    normalize({preset: 'default'}, {env: {}}).sectionIds
  , normalize({preset: 'conventional'}, {env: {}}).sectionIds
  )
})

test('normalize() accepts release-notes-generator config unchanged', async (t) => {
  const options = normalize({
    preset: 'angular'
  , linkCompare: false
  , linkReferences: false
  , host: 'https://git.example.com'
  , commit: 'commits'
  , issue: 'issue'
  }, {env: {}})

  t.equal(options.entryStyle, 'conventional', '`angular` is the conventional preset')
  t.equal(options.linkCompare, false)
  t.equal(options.includeCommitLinks, false)
  t.equal(options.linkHost, 'https://git.example.com')
  t.equal(options.commitPath, 'commits')
  t.equal(options.issuePath, 'issue')
  const both = {linkReferences: false, includeCommitLinks: true}
  t.equal(
    normalize(both, {env: {}}).includeCommitLinks
  , true
  , 'this plugin\'s own name wins'
  )
})

test('normalize() accepts an automatic or fixed heading level', async (t) => {
  const auto = {headingLevel: 'auto', preset: 'keepachangelog'}
  t.equal(normalize(auto, {env: {}}).headingLevel, 'auto')
  t.equal(normalize({headingLevel: 3}, {env: {}}).headingLevel, 3)
  t.equal(normalize({preset: 'keepachangelog'}, {env: {}}).headingLevel, 2)
})

test('normalize() falls back to the last section that is not breaking', async (t) => {
  const options = normalize({
    sections: [{id: 'changes'}, {id: 'notes'}, {id: 'breaking'}]
  }, {env: {}})
  t.equal(options.fallbackSection, 'notes')
  t.equal(
    normalize({sections: [{id: 'breaking'}]}, {env: {}}).fallbackSection
  , 'breaking'
  , 'unless it is the only one'
  )
})

test('normalize() renders an unknown preset as conventional', async (t) => {
  // A shared release config sets `preset` for commit-analyzer, and semantic-release
  // merges it into this plugin's options, so `preset: 'eslint'` is not a typo here.
  const options = normalize({preset: 'nope'}, {env: {}})
  const conventional = normalize({}, {env: {}})

  t.equal(options.presetFallback, 'nope')
  t.same(options.sections, conventional.sections)
  t.equal(conventional.presetFallback, '', 'a known preset falls back from nothing')
  t.equal(normalize({preset: 'angular'}, {env: {}}).presetFallback, '', 'nor an alias')

  const warning = presetWarning(options)
  t.match(warning, /`preset` is "nope".*the notes use "conventional"/)
  t.match(warning, /Its presets are conventional, keepachangelog\.$/)
  t.notMatch(warning, /default/, 'the alias is accepted but not advertised')
  t.equal(presetWarning(conventional), '')
})

test('normalize() rejects a non-string where a string is required', async (t) => {
  t.throws(
    () => { return normalize({model: 123}, {env: {}}) }
  , /The `model` option must be a string/
  )
})

test('normalize() rejects a non-object where an object is required', async (t) => {
  t.throws(() => { return normalize({typeSections: []}, {env: {}}) }, /must be an object/)
  t.throws(() => { return normalize({limits: 'nope'}, {env: {}}) }, /must be an object/)
})

test('normalize() copes with no plugin config and no context', async (t) => {
  const options = normalize(undefined, undefined)
  t.equal(options.audience.name, 'developers')
  t.equal(options.apiKey, '')
})

test('normalize() accepts a custom exclude list', async (t) => {
  const options = normalize({introspect: {exclude: ['**/generated/**']}}, {env: {}})
  t.same(options.introspect.exclude, ['**/generated/**'])
})

test('normalize() defaults to the first-party Anthropic provider', async (t) => {
  const options = normalize({}, {env: {ANTHROPIC_API_KEY: 'k'}})

  t.equal(options.provider, 'anthropic')
  t.equal(options.model, 'claude-opus-5-5', 'the model id is unprefixed')
  t.equal(options.apiKey, 'k')
  t.equal(options.promptCaching, true)
})

test('normalize() prefixes the model id for bedrock', async (t) => {
  const options = normalize({provider: 'bedrock'}, {env: {AWS_REGION: 'us-east-1'}})

  t.equal(options.model, 'anthropic.claude-opus-5-5')
  t.equal(options.region, 'us-east-1')
})

test('normalize() leaves an already-prefixed bedrock model alone', async (t) => {
  const options = normalize(
    {provider: 'bedrock', model: 'anthropic.claude-sonnet-5', region: 'us-west-2'}
  , {env: {}}
  )
  t.equal(options.model, 'anthropic.claude-sonnet-5', 'no double prefix')
})

test('normalize() ignores an Anthropic key under bedrock', async (t) => {
  const env = {ANTHROPIC_API_KEY: 'k', AWS_REGION: 'us-east-1'}
  const options = normalize({provider: 'bedrock'}, {env})
  t.equal(options.apiKey, '', 'AWS creds are used instead')
})

test('normalize() leaves prompt caching on for every provider', async (t) => {
  // Bedrock accepts cache points on every current Claude model. Defaulting it off
  // there meant a run paid full price for a context it resent every turn.
  const bedrock = normalize({provider: 'bedrock', region: 'us-east-1'}, {env: {}})
  t.equal(bedrock.promptCaching, true)
  t.equal(normalize({}, {env: {}}).promptCaching, true)
  t.equal(
    normalize({provider: 'bedrock', region: 'us-east-1', promptCaching: false}, {env: {}})
      .promptCaching
  , false
  , 'a model old enough to reject cache points can still turn it off'
  )
})

test('normalize() reads the region from either AWS env var', async (t) => {
  const env = {AWS_DEFAULT_REGION: 'eu-west-1'}
  const fromDefault = normalize({provider: 'bedrock'}, {env})
  t.equal(fromDefault.region, 'eu-west-1')
})

test('normalize() requires a region for bedrock', async (t) => {
  t.throws(
    () => { return normalize({provider: 'bedrock'}, {env: {}}) }
  , {code: 'ENOREGION'}
  )
})

test('normalize() rejects an unknown provider', async (t) => {
  t.throws(() => { return normalize({provider: 'vertex'}, {env: {}}) }, /provider/)
})

test('normalize() takes limits and tool budget from the effort level', async (t) => {
  // Effort tunes how much work is done. Before this it only reached the model's
  // reasoning knob, so `--effort low` bought cheaper thinking and identical reading.
  function profile(effort) {
    const options = normalize({effort}, {env: {}})
    return [
      options.limits.maxDetails
    , options.agent.maxToolCalls
    , options.agent.maxIterations
    , options.agent.maxTokens
    ]
  }

  t.same(profile('low'), [2, 10, 15, 8000])
  t.same(profile('medium'), [3, 30, 25, 12000])
  t.same(profile('high'), [4, 60, 40, 24000])
  t.same(profile('xhigh'), [4, 120, 70, 32000])
  t.same(profile('max'), [4, 200, 120, 48000], 'detail count stops; the budgets do not')
})

test('normalize() grows the token ceiling with the thinking it asks for', async (t) => {
  // Regression: a flat 16k ceiling is shared with adaptive thinking, so a
  // max-effort run hit it mid-submission and the release fell back to
  // conventional-changelog. Seen on sonnet, stop_reason max_tokens.
  let previous = 0
  for (const effort of ['low', 'medium', 'high', 'xhigh', 'max']) {
    const {maxTokens} = normalize({effort}, {env: {}}).agent
    t.ok(maxTokens > previous, `${effort}: ${maxTokens} exceeds ${previous}`)
    previous = maxTokens
  }
  t.ok(previous > 16000, 'and the top of the range clears the ceiling that failed')
})

test('normalize() gives every level the turns to spend its tool budget', async (t) => {
  // Regression: maxIterations was flat 40, so `max` was cut off after 39 turns
  // having spent 60 of its 200 calls. A budget the run cannot reach is not a budget.
  for (const effort of ['low', 'medium', 'high', 'xhigh', 'max']) {
    const agent = normalize({effort}, {env: {}}).agent
    t.ok(
      agent.maxIterations >= agent.maxToolCalls / 2
    , `${effort}: ${agent.maxIterations} turns for ${agent.maxToolCalls} calls`
    )
  }
})

test('normalize() lets explicit config beat the effort profile', async (t) => {
  const options = normalize({
    effort: 'low'
  , limits: {maxDetails: 9}
  , agent: {maxToolCalls: 7, maxIterations: 9, maxTokens: 2048}
  }, {env: {}})

  t.equal(options.limits.maxDetails, 9)
  t.equal(options.agent.maxToolCalls, 7)
  t.equal(options.agent.maxIterations, 9)
  t.equal(options.agent.maxTokens, 2048)
})

test('normalize() keeps the other agent defaults across effort levels', async (t) => {
  const low = normalize({effort: 'low'}, {env: {}}).agent
  const max = normalize({effort: 'max'}, {env: {}}).agent

  t.equal(low.maxListBytes, max.maxListBytes, 'the listing budget does not move')
  t.equal(low.maxSubmissionRetries, max.maxSubmissionRetries)
  t.equal(low.maxToolResultBytes, max.maxToolResultBytes)
})

test('normalize() validates limits like every other option', async (t) => {
  // `limits` was spread in untouched, so `maxDetails: 'all'` reached slice() as NaN
  // and every entry in the release rendered with no detail sentences at all.
  t.throws(
    () => { return normalize({limits: {maxDetails: 'all'}}, {env: {}}) }
  , {code: 'EINVALIDOPTION'}
  )
  t.throws(
    () => { return normalize({limits: {maxDetails: 0}}, {env: {}}) }
  , {code: 'EINVALIDOPTION'}
  , 'and a value out of range'
  )
  t.throws(
    () => { return normalize({limits: {headlne: 90}}, {env: {}}) }
  , {code: 'EINVALIDOPTION'}
  , 'a misspelled key fails rather than being silently ignored'
  )
  t.equal(normalize({limits: {detail: 90}}, {env: {}}).limits.detail, 90)
})

test('normalize() caps timeout at ten minutes', async (t) => {
  // The timeout bounds a silence, before a response starts or between streamed
  // events, so a longer one only delays noticing a stalled run.
  t.equal(normalize({}, {env: {}}).timeout, 600000)
  t.equal(normalize({timeout: 120000}, {env: {}}).timeout, 120000)
  t.throws(
    () => { return normalize({timeout: 20 * 60 * 1000}, {env: {}}) }
  , {code: 'EINVALIDOPTION'}
  , 'a longer one is refused'
  )
})

test('normalize() leaves an inference profile or ARN unprefixed', async (t) => {
  // An id that already names the provider is passed as written rather than given a
  // second prefix. Mantle rejects a profile or an ARN itself, naming the model.
  function model(id) {
    const config = {provider: 'bedrock', region: 'us-east-1', model: id}
    return normalize(config, {env: {}}).model
  }

  t.equal(model('claude-opus-5'), 'anthropic.claude-opus-5', 'a bare id gets one')
  t.equal(model('anthropic.claude-opus-5'), 'anthropic.claude-opus-5')
  t.equal(model('us.anthropic.claude-opus-5'), 'us.anthropic.claude-opus-5')
  t.equal(model('global.anthropic.claude-sonnet-5'), 'global.anthropic.claude-sonnet-5')
  t.equal(model('arn:aws:bedrock:us-east-1:1:x'), 'arn:aws:bedrock:us-east-1:1:x')
})

test('normalize() keeps an anthropic base url away from bedrock', async (t) => {
  const env = {ANTHROPIC_BASE_URL: 'https://proxy.internal'}

  t.equal(normalize({}, {env}).baseUrl, 'https://proxy.internal')
  t.equal(
    normalize({provider: 'bedrock', region: 'us-east-1'}, {env}).baseUrl
  , ''
  , 'a SigV4-signed request cannot be answered by an Anthropic gateway'
  )
})

test('normalize() reads a falsey verbose env var as off', async (t) => {
  for (const value of ['false', '0', 'no', 'off', '']) {
    const {verbose} = normalize({}, {env: {AUDIENCE_NOTES_VERBOSE: value}})
    t.notOk(verbose, value || '(empty)')
  }
  t.ok(normalize({}, {env: {AUDIENCE_NOTES_VERBOSE: '1'}}).verbose)
})

test('normalize() takes introspect.exclude as a string or a list', async (t) => {
  function exclude(value) {
    return normalize({introspect: {exclude: value}}, {env: {}}).introspect.exclude
  }

  t.same(exclude('dist/**'), ['dist/**'], 'a bare string is one pathspec')
  t.same(exclude(['a', 'b']), ['a', 'b'])
  t.throws(() => { return exclude(7) }, {code: 'EINVALIDINTROSPECT'})
})

test('normalize() rejects a wrong-typed number instead of coercing it', async (t) => {
  // Number(true) is 1 and Number('') is 0, so a typo became a valid option and
  // quietly changed the output.
  for (const config of [
    {headingLevel: true}
  , {maxRetries: false}
  , {limits: {detail: ''}}
  , {agent: {maxToolCalls: []}}
  ]) {
    t.throws(
      () => { return normalize(config, {env: {}}) }
    , {code: 'EINVALIDOPTION'}
    , JSON.stringify(config)
    )
  }
})

test('normalize() reads a quoted boolean the way it is written', async (t) => {
  // A JSON release config is where "false" comes from, and Boolean('false') is true.
  t.equal(normalize({includeOmitted: 'false'}, {env: {}}).includeOmitted, false)
  t.equal(normalize({includeOmitted: 'true'}, {env: {}}).includeOmitted, true)
  t.equal(normalize({includeOmitted: true}, {env: {}}).includeOmitted, true)
})

test('normalize() carries parserOpts and commitOpts from plugin config', async (t) => {
  // The fallback generator reads them from there, so the two paths would otherwise
  // parse the same release differently.
  const options = normalize({
    parserOpts: {issuePrefixes: ['LOG-']}
  , commitOpts: {ignore: '^wip'}
  }, {env: {}})

  t.same(options.parserOpts, {issuePrefixes: ['LOG-']})
  t.same(options.commitOpts, {ignore: '^wip'})
})

test('nearest() names the first known word within two edits', async (t) => {
  const known = ['effort', 'audience', 'model']
  t.equal(nearest('efort', known), 'effort')
  t.equal(nearest('AUDIANCE', known), 'audience', 'ignoring case')
  t.equal(nearest('provider', known), '', 'and nothing when none is close')
})
