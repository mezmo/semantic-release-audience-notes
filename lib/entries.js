import {
  CONFIDENCE_LEVELS
, IMPORTANCE_LEVELS
, MIN_BREAKING_IMPORTANCE
, OMISSION_REASONS
} from './constants.js'

const EMOJI_REGEX = /\p{Extended_Pictographic}/gu
// Only markers that would break the document's layout are removed. Inline
// code, brackets, and underscores are meaningful content -- stripping them
// mangles identifiers like `prompt_caching = true` and `[agent.llm]`.
// A symbol before a number is a comparison or a sign, as in `> 2 GB`, so it stays.
const BLOCK_MARKER_REGEX = /^\s*(?:[-*+>]\s+(?![\s\d])|#{1,6}\s+|\d+\.\s+)/

// Bold is applied by the renderer. A single `*` is left alone because it is
// meaningful inside paths and globs such as `hotfix/*`, and `**` is left alone
// inside a code span, where it is a glob such as `src/**/*.js`.
const EMPHASIS_REGEX = /\*\*/g
const CODE_SPAN_REGEX = /(`[^`]*`)/

// Commit text and the files the agent reads are written by anyone who can open a
// pull request, and the model can repeat them. A link or an image keeps only its
// text, because render.js builds every link the notes need. A `<` that opens a tag
// is escaped, so HTML shows as text and `a < b` reads as written. Markdown allows
// one level of brackets in link text and of parentheses in the destination.
const LINK_REGEX = /!?\[((?:[^[\]]|\[[^[\]]*\])*)\]\((?:[^()]|\([^()]*\))*\)/g
const TAG_OPEN_REGEX = /<(?=[A-Za-z/!?])/g
const WHITESPACE_REGEX = /\s+/g

// The agent supplies prose and grouping; this module supplies the shape. Every
// string it returns is re-cased, de-marked, and punctuated here, so output style
// never depends on the model having complied.
//
// Entries come in two kinds. A descriptive entry says what changed and claims its
// commits. An action entry lives in the section reserved for upgrade notes and
// says what the reader must do, so it usually restates a change described above
// it -- it references its commits instead of claiming them, or the one-claim rail
// would delete it for naming hashes an entry above already took.
//
// Three rails hold regardless of what the agent decided:
//   - a commit may be claimed by at most one descriptive entry
//   - a breaking commit always reaches the breaking section, never omitted
//   - a commit named nowhere at all is an oversight, not a choice
//
// How a breaking commit reaches the breaking section is `breakingPlacement`.
// Under `move` its entry is moved there. Under `restate` its entry stays where the
// agent filed it and the breaking section restates it, which is how Angular lists
// a commit under its type and its note under BREAKING CHANGES. Under `keep` its
// entry stays put and only a breaking commit with no entry is filed there.
//
// Which section an entry belongs in is the agent's judgement, taken as given. A
// commit type cannot stand in for it -- `feat(ci): snapshot docker hub pull
// totals` is contributor work whatever `feat` maps to.
function normalize(resolved, options) {
  const raws = resolved.entries
  const claimed = new Set()
  const referenced = new Set()
  const entries = []
  const actions = []
  const dropped = []

  // Descriptive entries run first so an action entry can never take a commit
  // away from the entry that explains it.
  for (const raw of raws) {
    if (isAction(raw, options)) continue
    // Commits are claimed against a scratch set until the entry survives, so a
    // dropped entry leaves its commits for the forgotten-commit path.
    const taken = new Set(claimed)
    const commits = claimCommits(raw.commits, taken)
    const supporting = claimCommits(raw.supporting, taken)
    if (!commits.length) {
      const why = raw.commits.length ? 'commits-already-claimed' : 'no-commits'
      dropped.push(drop(raw, why))
      continue
    }
    // A table with no fallback has no home for a section it does not know. Its
    // commits stay unclaimed so the forgotten-commit path accounts for them.
    if (!sectionFor(raw, commits.some(isBreaking), options)) {
      dropped.push(drop(raw, 'no-section'))
      continue
    }

    for (const hash of taken) claimed.add(hash)
    const entry = toEntry(raw, [...commits, ...supporting], options)
    // A supporting commit renders its link but never its own prose, so which
    // commits got no words of their own is otherwise invisible.
    entry.supporting = supporting.map((commit) => {
      return commit.hash
    })
    entries.push(entry)
  }

  for (const raw of raws) {
    if (!isAction(raw, options)) continue
    const commits = [...raw.commits, ...raw.supporting]
    if (!commits.length) {
      dropped.push(drop(raw, 'no-commits'))
      continue
    }
    // A section that restates breaking changes holds nothing else.
    if (options.breakingPlacement === 'restate' && !commits.some(isBreaking)) {
      dropped.push(drop(raw, 'not-breaking'))
      continue
    }

    // Where the action section and the breaking section are the same one, as they
    // are under keepachangelog, a breaking commit forced into it by sectionFor()
    // and an action entry restating it would both render there.
    if (options.actionSection === options.breakingSection) {
      const already = entries.some((entry) => {
        return entry.section === options.actionSection
          && commits.some((commit) => { return entry.hashes.includes(commit.hash) })
      })
      if (already) {
        dropped.push(drop(raw, 'restates-a-breaking-entry'))
        continue
      }
    }
    for (const commit of commits) {
      referenced.add(commit.hash)
      // An omission naming a commit an action entry already restates would render
      // it twice, and twice in one section where the two are the same section.
      claimed.add(commit.hash)
    }
    actions.push(toEntry(raw, commits, options))
  }

  const omitted = []
  for (const raw of resolved.omitted) {
    const commit = raw.commit
    if (claimed.has(commit.hash)) continue

    claimed.add(commit.hash)
    // A breaking change is never the model's to drop, whatever the audience.
    // Under `restate` the restatement below is what carries it.
    if (commit.breaking) {
      if (options.breakingPlacement !== 'restate') {
        entries.push(toEntry({section: options.breakingSection}, [commit], options))
      }
      continue
    }
    omitted.push({
      hash: commit.hash
    , fullHash: commit.fullHash
    , subject: bounded(commit.subject)
    , reason: OMISSION_REASONS.includes(raw.reason) ? raw.reason : 'no-audience-impact'
    })
  }

  // A commit carried only by an action entry is accounted for. Treating it as
  // missing would render it a second time, right beside the note about it.
  const missing = resolved.payload.filter((commit) => {
    return !claimed.has(commit.hash) && !referenced.has(commit.hash)
  })

  if (options.breakingPlacement === 'restate') {
    actions.push(...restatements(resolved.payload, referenced, options))
  }

  return {
    entries: [...entries, ...actions]
  , omitted
  , missing
  , dropped
  }
}

// Every breaking commit the agent did not restate gets the restatement Angular
// would print, one per breaking note, or the subject when it was marked with `!`.
function restatements(payload, referenced, options) {
  return payload.filter((commit) => {
    return commit.breaking && !referenced.has(commit.hash)
  }).flatMap((commit) => {
    const texts = commit.breakingNotes.length ? commit.breakingNotes : [commit.subject]
    return texts.map((text) => {
      return toEntry(
        {section: options.breakingSection, headline: text, confidence: 'low'}
      , [commit]
      , options
      )
    })
  })
}

function isBreaking(commit) {
  return commit.breaking
}

// An entry the rails delete took prose with it. The commit it carried is still
// accounted for, so nothing here is an error, but the words are gone and were
// invisible until they were named.
function drop(raw, reason) {
  return {
    headline: bounded(raw.headline)
  , section: raw.section
  , hashes: [...raw.commits, ...raw.supporting].map((commit) => {
      return commit.hash
    })
  , reason
  }
}

// Only a section the table marks as reader actions is derived. Where breaking
// changes get their own descriptive section instead, nothing is.
function isAction(raw, options) {
  return Boolean(options.actionSection) && Boolean(raw)
    && raw.section === options.actionSection
}

// A commit may be claimed once. When two entries name the same one the first
// claim wins, so it can never appear on two lines. Action entries skip this
// entirely -- they restate a change an entry above already claimed.
function claimCommits(commits, claimed) {
  return commits.filter((commit) => {
    if (claimed.has(commit.hash)) return false
    claimed.add(commit.hash)
    return true
  })
}

// Capping the number of sentences is what stops a verbose turn from turning one
// bullet into an essay. Their length is not capped here -- see bounded().
function normalizeDetails(details, limits) {
  if (!Array.isArray(details)) return []
  return details
    .map((detail) => {
      return bounded(detail)
    })
    .filter(Boolean)
    .slice(0, limits.maxDetails)
}

// Model prose is never cut. A model cannot count characters exactly, so a hard
// cap enforced by truncation mangles sentences that merely overshoot, losing the
// end of the thought. The length limits are stated in the prompt as targets;
// `maxDetails` is what actually bounds an entry.
function bounded(value) {
  return sentence(sanitize(value, 0), true)
}

function toEntry(raw, commits, options) {
  const limits = options.limits
  const breaking = commits.some(isBreaking)
  const section = sectionFor(raw, breaking, options)

  const references = [...new Set(commits.flatMap((commit) => {
    return commit.references
  }))]

  return {
    hashes: commits.map((commit) => {
      return commit.hash
    })
  , commits: commits.map((commit) => {
      return {hash: commit.hash, fullHash: commit.fullHash}
    })
  , section
  , scope: scopeOf(raw.scope || commits[0].scope, limits.scope)
  , headline: bounded(raw.headline)
      || bounded(commits[0].subject)
      || `Commit ${commits[0].hash}.`
  , details: normalizeDetails(raw.details, limits)
  , importance: importanceOf(raw.importance, breaking)
  , confidence: CONFIDENCE_LEVELS.includes(raw.confidence) ? raw.confidence : 'low'
  , references
  , breaking
  , supporting: []
  }
}

// A breaking change is floored rather than trusted. The parser already knows it
// forces work on the reader, whatever the agent judged.
function importanceOf(value, breaking) {
  const graded = IMPORTANCE_LEVELS.includes(value) ? value : 'medium'
  if (!breaking) return graded

  const floor = IMPORTANCE_LEVELS.indexOf(MIN_BREAKING_IMPORTANCE)
  return IMPORTANCE_LEVELS.indexOf(graded) > floor ? MIN_BREAKING_IMPORTANCE : graded
}

// Builds a deterministic entry for a commit the agent accounted for nowhere, so
// an oversight never silently drops a change from the notes. Returns null when
// the table has no section for the commit's type, as Angular has none for chores.
function fromCommit(commit, options) {
  const section = commit.breaking && options.breakingPlacement !== 'restate'
    ? options.breakingSection
    : sectionForType(commit.type, options)
  if (!section) return null
  return toEntry({section, confidence: 'low'}, [commit], options)
}

// Where a breaking change lands depends on the taxonomy, so it is named rather
// than hardcoded -- its own section by default, "Upgrade notes" under
// keepachangelog. A name the renderer does not iterate drops the entry.
//
// Everything else is the agent's judgement about what the change does for the
// reader, which a commit type cannot stand in for. `refactor(x): remove the
// prompt journal` is a removal whatever its prefix says.
function sectionFor(raw, breaking, options) {
  if (breaking && options.breakingPlacement === 'move') return options.breakingSection
  return options.sectionIds.includes(raw.section) ? raw.section : options.fallbackSection
}

// Only reached on the deterministic path, meaning a commit the agent forgot. In
// the normal path the agent reads the commit and picks
// the section itself, so an unfamiliar commit type costs nothing there.
function sectionForType(type, options) {
  return options.typeSections.get(String(type || '').toLowerCase())
    || options.fallbackSection
}

// Scopes are identifiers. Underscores are meaningful in one, so this
// deliberately does not reuse sanitize()'s markdown stripping.
function scopeOf(value, limit) {
  return clamp(
    String(value === undefined || value === null ? '' : value)
      .replace(EMOJI_REGEX, '')
      .replace(WHITESPACE_REGEX, ' ')
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9._/-]+/g, '-')
      .replace(/^-+|-+$/g, '')
  , limit
  )
}

function sanitize(value, limit) {
  let text = String(value === undefined || value === null ? '' : value)
    .replace(EMOJI_REGEX, '')
    .split(CODE_SPAN_REGEX)
    .map((part, index) => {
      if (index % 2) return part
      return unlink(part.replace(EMPHASIS_REGEX, '')).replace(TAG_OPEN_REGEX, '&lt;')
    })
    .join('')
    .replace(WHITESPACE_REGEX, ' ')
    .trim()

  // A leading bullet or heading would nest inside the list we render it into.
  let stripped = text.replace(BLOCK_MARKER_REGEX, '')
  while (stripped !== text) {
    text = stripped
    stripped = text.replace(BLOCK_MARKER_REGEX, '')
  }

  return clamp(text.trim(), limit)
}

// Repeats until nothing changes, because a linked image such as a badge leaves its
// image behind once the outer link goes.
function unlink(text) {
  const stripped = text.replace(LINK_REGEX, '$1')
  return stripped === text ? text : unlink(stripped)
}

// Truncates on a word boundary so a bounded sentence never ends mid-word.
function clamp(text, limit) {
  if (!limit || text.length <= limit) return text
  const cut = text.slice(0, limit)
  const boundary = cut.lastIndexOf(' ')
  const trimmed = boundary > limit * 0.6 ? cut.slice(0, boundary) : cut
  return trimmed.replace(/[\s,;:.-]+$/, '')
}

// A leading identifier keeps its own casing. Changelog lines legitimately open
// with `aura.usage`, `prompt_caching`, or `/mcp add`, and capitalizing those
// silently renames the thing being described.
// An underscore, slash, colon, or backtick anywhere in the first token marks it
// as code, as does a dot with something after it (`aura.usage`). A trailing dot
// is sentence punctuation, not an identifier.
const IDENTIFIER_HEAD_REGEX = /^[^\s]*(?:[_/:`]|\.[^\s.])/

function capitalize(text) {
  if (IDENTIFIER_HEAD_REGEX.test(text)) return text
  return text.charAt(0).toUpperCase() + text.slice(1)
}

function sentence(text, terminate) {
  if (!text) return ''
  const cased = capitalize(text)
  if (!terminate) return cased
  return /[.!?]$/.test(cased) ? cased : `${cased}.`
}

export {
  normalize
, bounded
, importanceOf
, fromCommit
, sanitize
, sentence
, clamp
, scopeOf
}
