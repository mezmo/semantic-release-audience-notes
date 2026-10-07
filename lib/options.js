import {AudienceNotesError} from './error.js'
import {
  AUDIENCE_PRESETS
, BEDROCK_MODEL_PREFIX
, DEFAULT_EXCLUDES
, DEFAULT_FALLBACK_SECTION
, DEFAULT_MODEL
, DEFAULT_PRESET
, EFFORT_LEVELS
, EFFORT_PROFILES
, ENTRY_ORDERS
, ENTRY_STYLES
, LIMITS
, PRESETS
, PRESET_ALIASES
, PROVIDERS
} from './constants.js'

// Fixed bounds on the agent loop. They tune the loop rather than the notes, so
// they are not options; `effort` sets the three budgets that are.
const AGENT_INTERNALS = {
  maxToolResultBytes: 24 * 1024
  // The opening prompt carries every commit message, so it is sized against the
  // whole release rather than against one answer. Paying this once replaces a
  // read_commit round trip per commit, and the round trips are what cost, because
  // every one of them re-sends the entire conversation.
, maxListBytes: 128 * 1024
, maxSubmissionRetries: 2
}

// Caps on what the read tools may return. The agent decides what to read; these
// bound how much any single answer can be.
const INTROSPECT_INTERNALS = {
  maxFilesPerCommit: 25
, contextLines: 3
}

// Every top-level option, so a near miss can be named. test/unit/options.js
// checks it against documentation/OPTIONS.md.
const KNOWN_OPTIONS = [
  'audience', 'provider', 'region', 'model', 'effort', 'apiKeyEnv', 'baseUrl'
, 'promptCaching', 'maxRetries', 'timeout', 'agent', 'introspect'
, 'preset', 'entryStyle', 'entryOrder', 'title', 'headingLevel', 'includeOmitted'
, 'includeConfidence', 'includeImportance', 'limits', 'sections', 'extraSections'
, 'typeSections'
, 'breakingSection', 'actionSection', 'includeCommitLinks', 'linkReferences'
, 'linkCompare', 'host', 'commit', 'issue', 'parserOpts', 'commitOpts', 'verbose'
, 'extraGuidance'
]

function normalize(pluginConfig, context) {
  const config = pluginConfig || {}
  const env = (context && context.env) || {}

  const sections = normalizeSections(config)
  const preset = sections.preset

  // Resolved first. Effort supplies the defaults that `limits` and `agent` fall back
  // to, so it has to exist before either of them is built.
  const effort = oneOf('effort', config.effort, EFFORT_LEVELS, 'high')
  const profile = EFFORT_PROFILES.get(effort)

  const options = {
    audience: normalizeAudience(config.audience)
  , sections: sections.list
  , sectionIds: sections.ids
  , typeSections: sections.typeMap
  , fallbackSection: sections.fallback
  , breakingSection: sections.breaking
  , actionSection: sections.action
  , breakingPlacement: sections.placement
    // The `preset` asked for when it is not one of this plugin's, so callers can
    // say it rendered as conventional instead.
  , presetFallback: sections.fallbackFrom
  , entryStyle: sections.entryStyle
  , introspect: normalizeIntrospect(config.introspect)
  , provider: oneOf('provider', config.provider, PROVIDERS, 'anthropic')
  , effort
  , maxRetries: int('maxRetries', config.maxRetries, 3, 0, 10)
  , timeout: int('timeout', config.timeout, 10 * 60 * 1000, 1000, 10 * 60 * 1000)
  , agent: normalizeAgent(config.agent, profile)
  , apiKeyEnv: str('apiKeyEnv', config.apiKeyEnv, 'ANTHROPIC_API_KEY')
  , baseUrl: str('baseUrl', config.baseUrl, env.ANTHROPIC_BASE_URL || '')
  , entryOrder: oneOf('entryOrder', config.entryOrder, ENTRY_ORDERS, preset.entryOrder)
    // `linkReferences`, `linkCompare`, `host`, `commit` and `issue` are
    // release-notes-generator's names, honored so its config carries over unchanged.
  , includeCommitLinks: bool(
      config.includeCommitLinks
    , bool(config.linkReferences, preset.includeCommitLinks)
    )
  , linkCompare: bool(config.linkCompare, true)
  , linkHost: str('host', config.host, '')
  , commitPath: str('commit', config.commit, '')
  , issuePath: str('issue', config.issue, '')
  , includeConfidence: bool(config.includeConfidence, false)
  , includeImportance: bool(config.includeImportance, false)
  , includeOmitted: bool(config.includeOmitted, false)
  , title: str('title', config.title, preset.title)
  , headingLevel: config.headingLevel === 'auto'
      ? 'auto'
      : int('headingLevel', config.headingLevel, preset.headingLevel, 1, 4)
  , limits: normalizeLimits(config.limits, profile, preset)
  , verbose: bool(config.verbose, flag(env.AUDIENCE_NOTES_VERBOSE))
  , parserOpts: objectOf('parserOpts', config.parserOpts)
  , commitOpts: objectOf('commitOpts', config.commitOpts)
  , extraGuidance: str('extraGuidance', config.extraGuidance, '')
  }

  const model = str('model', config.model, DEFAULT_MODEL)
  options.model = resolveModel(model, options.provider)
  options.region = str(
    'region'
  , config.region
  , env.AWS_REGION || env.AWS_DEFAULT_REGION || ''
  )
  // Read from the environment only, so a key never has a reason to sit in a
  // committed release config. Bedrock authenticates through the AWS credential
  // chain, so no key is read there.
  options.apiKey = options.provider === 'bedrock' ? '' : env[options.apiKeyEnv] || ''
  // Same reasoning as the key. ANTHROPIC_BASE_URL is exported by anyone routing
  // Claude through a gateway, and a SigV4-signed request cannot go there.
  if (options.provider === 'bedrock') options.baseUrl = ''

  // Every current Claude model accepts cache points on Bedrock as well as on the
  // first-party API, so this is on by default for both. A model old enough to
  // reject them fails the request outright rather than degrading, which is the
  // signal to set this false.
  options.promptCaching = bool(config.promptCaching, true)

  if (options.provider === 'bedrock' && !options.region) {
    throw new AudienceNotesError(
      'ENOREGION'
    , 'The `bedrock` provider needs a region.'
    , 'Set the `region` option, or AWS_REGION in the release environment.'
    )
  }

  return options
}

// Resolves the one section table every other module reads. A preset supplies
// the table, the breaking-change destination, and the entry style together,
// since those three have to agree; each can still be overridden individually.
function normalizeSections(config) {
  const requested = str('preset', config.preset, DEFAULT_PRESET)
  const presetName = PRESET_ALIASES.get(requested) || requested
  // release-notes-generator takes a conventional-changelog preset under the same
  // name, and semantic-release passes a global `preset` to every plugin. A name
  // this plugin does not have renders as conventional, and callers warn.
  const preset = PRESETS.get(presetName) || PRESETS.get(DEFAULT_PRESET)

  const presetTable = config.sections === undefined || config.sections === null
  const extras = selectExtras(config.extraSections, preset, presetTable)
  const list = presetTable
    ? ordered([...preset.sections, ...extras], preset).map((section) => {
      const {id, title, description, types} = section
      return {id, title, description, types: [...types]}
    })
    : parseSections(config.sections)

  const ids = list.map((section) => {
    return section.id
  })

  if (new Set(ids).size !== ids.length) {
    throw new AudienceNotesError('EINVALIDSECTIONS', 'Section ids must be unique.')
  }

  // The rail that refuses to drop a breaking change needs a section to put it
  // in. Which section that is depends on the taxonomy, so it is named rather
  // than hardcoded: "breaking" by default, "changed" or "upgrade" under
  // keepachangelog.
  const movesTo = extras.find((extra) => { return extra.breaking })
  const breakingDefault = movesTo ? movesTo.id : preset.breakingSection
  const breaking = str('breakingSection', config.breakingSection, breakingDefault)
  if (!ids.includes(breaking)) {
    throw new AudienceNotesError(
      'EINVALIDSECTIONS'
    , `\`breakingSection\` is "${breaking}", which is not in the section table.`
    , `Known sections: ${ids.join(', ')}. Breaking changes are always rendered, `
        + 'so they need somewhere to live.'
    )
  }

  const typeMap = new Map()
  for (const section of list) {
    for (const type of section.types) {
      typeMap.set(String(type).toLowerCase(), section.id)
    }
  }

  const overrides = objectOf('typeSections', config.typeSections)
  for (const [type, id] of Object.entries(overrides)) {
    if (!ids.includes(id)) {
      throw new AudienceNotesError(
        'EINVALIDSECTIONS'
      , `\`typeSections.${type}\` points at unknown section "${id}".`
      , `Known sections: ${ids.join(', ')}.`
      )
    }
    typeMap.set(String(type).toLowerCase(), id)
  }

  const catchAll = extras.find((extra) => { return extra.fallback })
  let fallback = defaultFallback(ids, breaking)
  const ownFallback = presetTable && preset.fallbackSection !== undefined
  if (ownFallback) fallback = preset.fallbackSection
  if (catchAll) fallback = catchAll.id

  const actions = extras.find((extra) => { return extra.action })
  const actionDefault = actions ? actions.id : preset.actionSection
  const action = str('actionSection', config.actionSection, actionDefault)
  if (action && !ids.includes(action)) {
    throw new AudienceNotesError(
      'EINVALIDSECTIONS'
    , `\`actionSection\` is "${action}", which is not in the section table.`
    , `Known sections: ${ids.join(', ')}. Use an empty string for a table whose `
        + 'sections all describe changes rather than asking something of the reader.'
    )
  }

  return {
    list
  , ids
  , typeMap
  , fallback
  , breaking
  , action
  , placement: placementFor(preset, movesTo, breaking, action)
  , entryStyle: oneOf('entryStyle', config.entryStyle, ENTRY_STYLES, preset.entryStyle)
  , preset
  , fallbackFrom: PRESETS.has(presetName) ? '' : requested
  }
}

// Restating only works where the restatement lands in the breaking section, and
// a section added to hold breaking changes holds them by moving them there.
function placementFor(preset, movesTo, breaking, action) {
  if (movesTo) return 'move'
  if (preset.breakingPlacement === 'restate' && breaking !== action) return 'move'
  return preset.breakingPlacement
}

// Angular orders its groups by title and lists breaking changes after them all,
// so a preset that follows it sorts its table the same way once extras join it.
function ordered(sections, preset) {
  if (preset.sectionOrder !== 'title') return sections
  const last = preset.breakingSection
  const rest = sections.filter((section) => { return section.id !== last })
  rest.sort((left, right) => { return left.title.localeCompare(right.title, 'en') })
  return [...rest, ...sections.filter((section) => { return section.id === last })]
}

// Optional sections a preset offers, in the preset's order whatever order they
// were asked for in. They extend the preset's own table, so a custom `sections`
// list should include them itself.
function selectExtras(value, preset, presetTable) {
  if (value === undefined || value === null) return []
  const available = preset.extraSections
  const ids = available.map((extra) => { return extra.id })
  if (!Array.isArray(value)) {
    throw new AudienceNotesError(
      'EINVALIDSECTIONS'
    , 'The `extraSections` option must be an array of section ids.'
    )
  }
  const unknown = value.filter((id) => { return !ids.includes(id) })
  if (unknown.length) {
    throw new AudienceNotesError(
      'EINVALIDSECTIONS'
    , `Unknown \`extraSections\`: ${unknown.join(', ')}.`
    , `This preset offers: ${ids.join(', ')}.`
    )
  }
  if (!presetTable && value.length) {
    throw new AudienceNotesError(
      'EINVALIDSECTIONS'
    , '`extraSections` adds to a preset\'s own table, so it cannot join `sections`.'
    , 'List the extra sections in `sections` instead.'
    )
  }
  return available.filter((extra) => { return value.includes(extra.id) })
}

// A custom table gets `internal` when it has one. Otherwise the last section that
// is not the breaking one, since a commit filed there by type alone would read as
// a breaking change.
function defaultFallback(ids, breaking) {
  if (ids.includes(DEFAULT_FALLBACK_SECTION)) return DEFAULT_FALLBACK_SECTION
  const others = ids.filter((id) => { return id !== breaking })
  return others.length ? others[others.length - 1] : breaking
}

function parseSections(sections) {
  if (!Array.isArray(sections) || !sections.length) {
    throw new AudienceNotesError(
      'EINVALIDSECTIONS'
    , 'The `sections` option must be a non-empty array.'
    )
  }

  return sections.map((section, index) => {
    if (!section || typeof section !== 'object' || !section.id) {
      throw new AudienceNotesError(
        'EINVALIDSECTIONS'
      , `Section at index ${index} needs an \`id\`.`
      )
    }
    return {
      id: String(section.id)
    , title: String(section.title || section.id)
    , description: String(section.description || '')
    , types: Array.isArray(section.types) ? section.types.map(String) : []
    }
  })
}

// Bedrock ids are prefixed; first-party ids are not. An id that already names the
// provider, such as an inference profile or an ARN, is passed as written. Mantle,
// the endpoint the Bedrock client calls, serves only `anthropic.` ids and rejects
// the others with a 400 that names the model.
function resolveModel(model, provider) {
  if (provider !== 'bedrock') return model
  const named = model.includes(BEDROCK_MODEL_PREFIX) || model.startsWith('arn:')
  return named ? model : `${BEDROCK_MODEL_PREFIX}${model}`
}

function normalizeAudience(value) {
  const raw = str('audience', value, 'developers').trim()
  if (!raw) {
    throw new AudienceNotesError(
      'EINVALIDAUDIENCE'
    , 'The `audience` option must be a non-empty string.'
    )
  }

  const preset = AUDIENCE_PRESETS.get(raw.toLowerCase())
  return {
    name: raw
  , description: preset || raw
  , isPreset: Boolean(preset)
  }
}

function normalizeIntrospect(value) {
  if (value === undefined || value === null) {
    return {...INTROSPECT_INTERNALS, exclude: DEFAULT_EXCLUDES}
  }

  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new AudienceNotesError(
      'EINVALIDINTROSPECT'
    , 'The `introspect` option must be an object.'
    )
  }
  rejectUnknown('introspect', value, ['exclude'])

  return {...INTROSPECT_INTERNALS, exclude: normalizeExclude(value.exclude)}
}

function normalizeLimits(value, profile, preset) {
  const defaults = {...LIMITS, ...preset.limits, maxDetails: profile.maxDetails}
  const given = objectOf('limits', value)
  rejectUnknown('limits', given, Object.keys(defaults))
  const limits = {...defaults}

  for (const key of Object.keys(defaults)) {
    limits[key] = int(`limits.${key}`, given[key], defaults[key], 1, 10000)
  }

  return limits
}

// The nested options belong to this plugin alone, so an unknown key in one is a
// mistake rather than another plugin's setting.
function rejectUnknown(name, given, known) {
  const unknown = Object.keys(given).filter((key) => {
    return !known.includes(key)
  })
  if (!unknown.length) return
  throw new AudienceNotesError(
    'EINVALIDOPTION'
  , `Unknown \`${name}\` keys: ${unknown.join(', ')}.`
  , `Known ${name} keys: ${known.join(', ')}.`
  )
}

// A bare string is a single pathspec, not a list of characters, and silently
// dropping it would leave a lockfile reaching the model.
function normalizeExclude(value) {
  if (value === undefined || value === null) return DEFAULT_EXCLUDES
  if (typeof value === 'string') return [value]
  if (Array.isArray(value)) return value.map(String)

  throw new AudienceNotesError(
    'EINVALIDINTROSPECT'
  , 'The `introspect.exclude` option must be a string or an array of strings.'
  )
}

function normalizeAgent(value, profile) {
  if (value === undefined || value === null) {
    return {
      ...AGENT_INTERNALS
    , maxIterations: profile.maxIterations
    , maxToolCalls: profile.maxToolCalls
    , maxTokens: profile.maxTokens
    }
  }

  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new AudienceNotesError('EINVALIDAGENT', 'The `agent` option must be an object.')
  }
  rejectUnknown('agent', value, ['maxIterations', 'maxToolCalls', 'maxTokens'])

  return {
    ...AGENT_INTERNALS
  , maxIterations: int(
      'agent.maxIterations'
    , value.maxIterations
    , profile.maxIterations
    , 2
    , 400
    )
  , maxToolCalls: int(
      'agent.maxToolCalls'
    , value.maxToolCalls
    , profile.maxToolCalls
    , 1
    , 500
    )
  , maxTokens: int('agent.maxTokens', value.maxTokens, profile.maxTokens, 1024, 128000)
  }
}

function str(name, value, fallback) {
  if (value === undefined || value === null) return fallback
  if (typeof value !== 'string') {
    throw new AudienceNotesError(
      'EINVALIDOPTION'
    , `The \`${name}\` option must be a string, received ${typeof value}.`
    )
  }
  return value
}

// An env var is a string, so "false" and "0" would otherwise read as true.
function flag(value) {
  if (!value) return false
  return !['false', '0', 'no', 'off'].includes(String(value).trim().toLowerCase())
}

function bool(value, fallback) {
  if (value === undefined || value === null) return fallback
  if (typeof value === 'string') return flag(value)
  return Boolean(value)
}

function int(name, value, fallback, min, max) {
  if (value === undefined || value === null) return fallback
  if (typeof value !== 'number' && typeof value !== 'string') {
    throw new AudienceNotesError(
      'EINVALIDOPTION'
    , `The \`${name}\` option must be a number, received ${typeof value}.`
    )
  }
  const parsed = String(value).trim() === '' ? NaN : Number(value)
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new AudienceNotesError(
      'EINVALIDOPTION'
    , `The \`${name}\` option must be an integer between ${min} and ${max}.`
    )
  }
  return parsed
}

function oneOf(name, value, allowed, fallback) {
  if (value === undefined || value === null) return fallback
  if (!allowed.includes(value)) {
    throw new AudienceNotesError(
      'EINVALIDOPTION'
    , `The \`${name}\` option must be one of: ${allowed.join(', ')}.`
    )
  }
  return value
}

function objectOf(name, value) {
  if (value === undefined || value === null) return {}
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new AudienceNotesError('EINVALIDOPTION', `The \`${name}\` option must be an object.`)
  }
  return value
}

// The first-party API needs a key; Bedrock authenticates through AWS. Shared by
// verifyConditions and generateNotes, so both stop a release the same way.
function assertApiKey(options) {
  if (options.provider === 'bedrock' || options.apiKey) return
  throw new AudienceNotesError(
    'ENOAPIKEY'
  , `No API key found in the \`${options.apiKeyEnv}\` environment variable.`
  , 'Set the variable in the release environment.'
  )
}

// A `preset` this plugin does not have renders as conventional. Empty when the
// preset is one of its own.
function presetWarning(options) {
  if (!options.presetFallback) return ''
  return `\`preset\` is "${options.presetFallback}", which this plugin does not have, so`
    + ` the notes use "${DEFAULT_PRESET}". Its presets are`
    + ` ${[...PRESETS.keys()].join(', ')}.`
}

// semantic-release merges its own options and every other plugin's into this
// config, so an unknown key is normal. Only one within two edits of a real option
// is named, which catches a typo without flagging `branches` or `releaseRules`.
function misspelledOptions(pluginConfig) {
  const config = pluginConfig || {}
  return Object.keys(config).flatMap((key) => {
    if (KNOWN_OPTIONS.includes(key) || key.length < 4) return []
    const near = nearest(key, KNOWN_OPTIONS)
    return near ? [{key, suggestion: near}] : []
  })
}

// The first of `known` within two edits of `key`, ignoring case, or ''.
function nearest(key, known) {
  return known.find((name) => {
    return distance(key.toLowerCase(), name.toLowerCase()) <= 2
  }) || ''
}

// Levenshtein distance over two short strings.
function distance(a, b) {
  let previous = Array.from({length: b.length + 1}, (_, index) => { return index })
  for (let i = 1; i <= a.length; i++) {
    const current = [i]
    for (let j = 1; j <= b.length; j++) {
      const swap = previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
      current.push(Math.min(previous[j] + 1, current[j - 1] + 1, swap))
    }
    previous = current
  }
  return previous[b.length]
}

export {
  KNOWN_OPTIONS
, assertApiKey
, misspelledOptions
, nearest
, normalize
, presetWarning
}
