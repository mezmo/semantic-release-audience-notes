const PLUGIN_NAME = 'semantic-release-audience-notes'

// The default section table mirrors conventional-changelog-angular, the preset
// @semantic-release/release-notes-generator loads when none is configured. Array
// order is render order, which is Angular's alphabetical group order with breaking
// changes last. `types` drives the deterministic path when the agent never
// described a commit, and `description` is what the agent is told the section
// means. One table, so the schema enum, the prompt and the renderer can never
// disagree.
//
// Angular hides every other type, so this table has no home for them. The agent
// omits that work as internal-only.
//
// Override wholesale with the `sections` option, or map extra commit types onto
// these with `typeSections`.
const DEFAULT_SECTIONS = [
  {
    id: 'fixes'
  , title: 'Bug Fixes'
  , description: 'the change corrects behavior that was already meant to work.'
  , types: ['fix', 'bugfix']
  }
, {
    id: 'features'
  , title: 'Features'
  , description: 'the change adds a capability that did not exist before.'
  , types: ['feat', 'feature']
  }
, {
    id: 'performance'
  , title: 'Performance Improvements'
  , description:
      'the change alters speed, throughput, memory, or cost with no behavior change.'
  , types: ['perf']
  }
, {
    id: 'reverts'
  , title: 'Reverts'
  , description: 'the change undoes a commit from an earlier release.'
  , types: ['revert']
  }
, {
    id: 'breaking'
  , title: 'BREAKING CHANGES'
  , description:
      'restates a breaking change described in another section as what breaks and '
        + 'what the reader must do.'
  , types: []
  }
]

// The groups Angular hides unless a commit in them is breaking, titled as Angular
// and conventional-changelog-conventionalcommits title them. Enabled one at a time
// with `extraSections`, each sorts into the table by title, as Angular orders
// its groups.
const DEFAULT_EXTRAS = [
  {
    id: 'docs'
  , title: 'Documentation'
  , description: 'the change only affects documentation, comments, or examples.'
  , types: ['docs', 'doc']
  }
, {
    id: 'style'
  , title: 'Styles'
  , description: 'the change only affects formatting, with no change in behavior.'
  , types: ['style']
  }
, {
    id: 'refactor'
  , title: 'Code Refactoring'
  , description: 'the change restructures code without changing what it does.'
  , types: ['refactor']
  }
, {
    id: 'test'
  , title: 'Tests'
  , description: 'the change only adds or corrects tests.'
  , types: ['test', 'tests']
  }
, {
    id: 'build'
  , title: 'Build System'
  , description: 'the change affects the build, packaging, or dependencies.'
  , types: ['build']
  }
, {
    id: 'ci'
  , title: 'Continuous Integration'
  , description: 'the change affects CI configuration or scripts.'
  , types: ['ci']
  }
, {
    id: 'chore'
  , title: 'Miscellaneous Chores'
  , description: 'routine maintenance that fits no other section.'
  , types: ['chore']
  }
]

const DEFAULT_FALLBACK_SECTION = 'internal'

// Keep a Changelog 1.1.0's six types of change, in the order the spec lists them.
const KEEPACHANGELOG_SECTIONS = [
  {
    id: 'added'
  , title: 'Added'
  , description: 'a capability that did not exist before.'
  , types: ['feat', 'feature']
  }
, {
    id: 'changed'
  , title: 'Changed'
  , description: 'existing behavior works differently now.'
  , types: ['refactor', 'perf', 'style']
  }
, {
    id: 'deprecated'
  , title: 'Deprecated'
  , description: 'something still works but is marked for removal in a future release.'
  , types: ['deprecate', 'deprecation']
  }
, {
    id: 'removed'
  , title: 'Removed'
  , description: 'something that existed is gone.'
  , types: ['remove']
  }
, {
    id: 'fixed'
  , title: 'Fixed'
  , description: 'behavior that was already meant to work now does.'
  , types: ['fix', 'bugfix', 'revert']
  }
, {
    id: 'security'
  , title: 'Security'
  , description: 'the change closes a vulnerability or hardens against one.'
  , types: ['security']
  }
]

// Sections the spec does not have, enabled one at a time with `extraSections`.
// They render after the spec's six, in this order. `breaking` makes the section
// where breaking changes move, and `action` makes it hold reader actions.
const KEEPACHANGELOG_EXTRAS = [
  {
    id: 'upgrade'
  , title: 'Upgrade notes'
  , description:
      'the reader must do something to adopt this release, such as a changed '
        + 'default, a migration, a compatibility break, or a size or cost change.'
  , types: []
  , breaking: true
  , action: true
  }
, {
    id: 'contributors'
  , title: 'For contributors'
  , description:
      'only matters to someone working on this repository, covering build times, '
        + 'CI, dependency plumbing, and the release process.'
  , types: ['ci', 'build', 'chore', 'test', 'tests']
  , fallback: true
  }
]

// `conventional` renders what @semantic-release/release-notes-generator renders
// with its default Angular preset, so swapping this plugin in changes the words
// and nothing else. A breaking change is described under its own type and then
// restated under BREAKING CHANGES, the way Angular lists a commit and its note.
//
// `breakingPlacement` decides how a breaking commit reaches `breakingSection`:
//   - restate: its entry stays put and the breaking section restates it
//   - move: its entry moves into the breaking section
//   - keep: its entry stays put; only an omitted or forgotten one is filed there
//
// `fallbackSection: ''` means a type with no section has no home, as in Angular.
const PRESETS = new Map([
  ['conventional', {
    sections: DEFAULT_SECTIONS
  , extraSections: DEFAULT_EXTRAS
  , sectionOrder: 'title'
  , breakingSection: 'breaking'
  , actionSection: 'breaking'
  , breakingPlacement: 'restate'
  , fallbackSection: ''
  , entryStyle: 'conventional'
  , entryOrder: 'scope'
  , includeCommitLinks: true
  , title: '{versionLink} ({date})'
  , headingLevel: 'auto'
    // The headline is the whole entry here, so it is given the room details get
    // under the prose style.
  , limits: {headline: 200}
  }]
, ['keepachangelog', {
    sections: KEEPACHANGELOG_SECTIONS
  , extraSections: KEEPACHANGELOG_EXTRAS
    // The spec has no breaking section. A breaking entry stays where the agent
    // filed it, usually Changed or Removed, and one it left out is filed in Changed.
  , breakingSection: 'changed'
  , actionSection: ''
  , breakingPlacement: 'keep'
  , fallbackSection: ''
  , entryStyle: 'prose'
  , entryOrder: 'importance'
  , includeCommitLinks: false
  , title: '{versionLink} - {date}'
  , headingLevel: 2
  }]
])

// `default` was the original name for the conventional preset. `angular` is the
// name release-notes-generator users already have in their config.
const PRESET_ALIASES = new Map([['default', 'conventional'], ['angular', 'conventional']])

const DEFAULT_PRESET = 'conventional'

const ENTRY_STYLES = ['conventional', 'prose']

const AUDIENCE_PRESETS = new Map([
  ['developers'
  , 'Application developers who consume this package or service as a dependency.'
  ]
, ['operators'
  , 'Operators and SREs who deploy, monitor, and troubleshoot this in production.'
  ]
, ['end-users', 'Non-technical end users of the product interacting through its UI.']
, ['executives'
  , 'Business stakeholders tracking delivery risk, customer impact, and commitments.'
  ]
, ['security'
  , 'Security engineers reviewing changes for exposure, hardening, and compliance impact.'
  ]
, ['support'
  , 'Support engineers who answer customer questions and triage incoming reports.'
  ]
])

const DEFAULT_EXCLUDES = [
  '**/package-lock.json'
, '**/npm-shrinkwrap.json'
, '**/yarn.lock'
, '**/pnpm-lock.yaml'
, '**/Cargo.lock'
, '**/go.sum'
, '**/poetry.lock'
, '**/composer.lock'
, '**/*.snap'
, '**/*.min.js'
, '**/*.map'
, '**/dist/**'
, '**/build/**'
, '**/vendor/**'
, '**/node_modules/**'
, '**/testdata/**'
, '**/__fixtures__/**'
]

const LIMITS = {
  scope: 32
, headline: 120
, detail: 260
, maxDetails: 4
}

const CONFIDENCE_LEVELS = ['high', 'medium', 'low']

// Ordered most to least important; the array order is the sort order.
const IMPORTANCE_LEVELS = ['critical', 'high', 'medium', 'low']

// A commit the parser flagged breaking can never be ranked below this.
const MIN_BREAKING_IMPORTANCE = 'high'

// Why a commit earned no line in the notes. A closed vocabulary so the decision
// is auditable rather than free text.
const OMISSION_REASONS = [
  'no-audience-impact'
, 'internal-only'
, 'trivial'
, 'superseded'
]
const ENTRY_ORDERS = ['importance', 'scope', 'commit']
const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max']

// What each effort level buys. Effort tunes how much work is done, never whether
// the output is correct -- coverage, section placement, upgrade notes, and the
// rule against stating a value nobody read hold at every level.
//
// `maxDetails` stops climbing at 4 on purpose. Entries already run long, so more
// effort should buy better-sourced sentences rather than more of them.
// `maxToolCalls` is a ceiling, not a target: 83 commits used 36-41 calls.
// `maxIterations` is about half the tool budget, since a turn that batches asks
// for roughly two things. A budget the run cannot reach in its turns is not a
// budget.
//
// `maxTokens` is a per-request ceiling shared with adaptive thinking, so it grows
// with how hard the model is asked to think. Raising a ceiling costs nothing
// until it is used; too low a one truncates a submission mid-write.
const EFFORT_PROFILES = new Map([
  ['low', {
    maxDetails: 2, maxToolCalls: 10, maxIterations: 15, maxTokens: 8000
  , readsCode: false
  }]
, ['medium', {
    maxDetails: 3, maxToolCalls: 30, maxIterations: 25, maxTokens: 12000
  , readsCode: false
  }]
, ['high', {
    maxDetails: 4, maxToolCalls: 60, maxIterations: 40, maxTokens: 24000
  , readsCode: true
  }]
, ['xhigh', {
    maxDetails: 4, maxToolCalls: 120, maxIterations: 70, maxTokens: 32000
  , readsCode: true
  }]
, ['max', {
    maxDetails: 4, maxToolCalls: 200, maxIterations: 120, maxTokens: 48000
  , readsCode: true
  }]
])
// Undated, so it tracks revisions within 5.5 but never crosses a version
// boundary. Moving to a later Opus is a deliberate edit, not something inherited.
const DEFAULT_MODEL = 'claude-opus-5-5'

const PROVIDERS = ['anthropic', 'bedrock']

// Bedrock model ids carry a provider prefix; first-party ids do not.
const BEDROCK_MODEL_PREFIX = 'anthropic.'

export {
  PLUGIN_NAME
, IMPORTANCE_LEVELS
, MIN_BREAKING_IMPORTANCE
, OMISSION_REASONS
, DEFAULT_FALLBACK_SECTION
, PRESETS
, PRESET_ALIASES
, DEFAULT_PRESET
, ENTRY_STYLES
, AUDIENCE_PRESETS
, DEFAULT_EXCLUDES
, LIMITS
, CONFIDENCE_LEVELS
, ENTRY_ORDERS
, EFFORT_LEVELS
, EFFORT_PROFILES
, DEFAULT_MODEL
, PROVIDERS
, BEDROCK_MODEL_PREFIX
}
