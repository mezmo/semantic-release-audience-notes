import {CommitParser} from 'conventional-commits-parser'
import {filterRevertedCommitsSync} from 'conventional-commits-filter'

// The `!` breaking marker is consumed but not captured by the standard
// headerPattern, so it is detected separately from the raw header.
const BREAKING_NOTE_REGEX = /^BREAKING[ -]CHANGES?$/i
const BANG_BREAKING_REGEX = /^\w+(?:\([^)]*\))?!:/

const DEFAULT_PARSER_OPTS = {
  noteKeywords: ['BREAKING CHANGE', 'BREAKING CHANGES', 'BREAKING-CHANGE']
, headerPattern: /^(\w*)(?:\((.*)\))?!?: (.*)$/
, headerCorrespondence: ['type', 'scope', 'subject']
}

// Builds the compact, deterministic payload handed to the model. Commit
// parsing is delegated to conventional-commits-parser using the host defaults
// plus the release config's own parserOpts, so existing commit conventions
// (including custom issue prefixes) carry over.
function build(commits, options, context, repository) {
  const host = (repository && repository.host) || {}
  const parserOpts = {
    ...DEFAULT_PARSER_OPTS
  , referenceActions: host.referenceActions
  , issuePrefixes: host.issuePrefixes
    // semantic-release merges its own options into every plugin config, so both
    // places can carry these. Plugin config wins where both are present.
  , ...((context && context.options && context.options.parserOpts) || {})
  , ...options.parserOpts
  }
  const parser = new CommitParser(parserOpts)
  const commitOpts = {
    ...((context && context.options && context.options.commitOpts) || {})
  , ...options.commitOpts
  }

  const parsed = []
  // Compiled once rather than per commit.
  // Rebuilt without flags: a /g pattern advances lastIndex between .test() calls,
  // so every other matching commit escapes the filter.
  const ignored = commitOpts.ignore ? withoutGlobal(commitOpts.ignore) : null

  for (const commit of commits) {
    const hash = commit.hash || (commit.commit && commit.commit.long) || ''
    if (!hash) continue

    const message = commit.message
      || [commit.subject, commit.body].filter(Boolean).join('\n\n')
    if (!message.trim()) continue
    if (ignored && ignored.test(message)) continue

    // `raw` is reserved. conventional-commits-filter matches reverts against
    // `commit.raw || commit`, so a `raw` key here would break revert detection.
    parsed.push({source: commit, hash, message, ...parser.parse(message)})
  }

  // Drops commits that were reverted later in the same release window.
  // filterRevertedCommitsSync yields a generator, not an array.
  const kept = [...filterRevertedCommitsSync(parsed)]
  const length = abbreviate(kept.map((commit) => { return commit.hash }))

  return kept.map((commit) => { return toPayloadEntry(commit, length) })
}

function toPayloadEntry(commit, length = 7) {
  // Only a breaking-change note makes a commit breaking. A custom `noteKeyword`
  // such as DEPRECATED parses into the same list, and treating it as breaking
  // forces the commit into the breaking section and floors its importance.
  const notes = (commit.notes || []).filter((note) => {
    return BREAKING_NOTE_REGEX.test(String(note.title || ''))
  })
  const breakingNotes = notes.map((note) => {
    return note.text.trim()
  }).filter(Boolean)

  const entry = {
    hash: shortHash(commit.hash, length)
  , fullHash: commit.hash
  , type: commit.type || ''
  , scope: commit.scope || ''
  , subject: (commit.subject || commit.header || '').trim()
  , body: (commit.body || '').trim()
  , breaking: breakingNotes.length > 0 || BANG_BREAKING_REGEX.test(commit.header || '')
  , breakingNotes
  , references: (commit.references || []).map(formatReference).filter(Boolean)
  }

  return entry
}

// A reference to another repository keeps its owner and repository, so
// `mezmo/rig#12` never renders as `#12` and links to this repo's issue 12.
function formatReference(ref) {
  const issue = `${ref.prefix || ''}${ref.issue || ''}`
  if (!ref.issue) return ''
  return ref.owner && ref.repository
    ? `${ref.owner}/${ref.repository}${issue}`
    : issue
}

// A /g pattern advances lastIndex between .test() calls, so every other matching
// commit escapes. Only that flag is dropped; i, m and s are how this option is
// normally written.
function withoutGlobal(pattern) {
  if (!(pattern instanceof RegExp)) return new RegExp(String(pattern))
  return new RegExp(pattern.source, pattern.flags.replace('g', ''))
}

function shortHash(hash, length = 7) {
  return String(hash).slice(0, length)
}

// Abbreviations are lengthened until no two commits in the release share one, the
// way git does it. Two commits under one map key would lose the second silently.
function abbreviate(hashes) {
  for (let length = 7; length < 40; length++) {
    const seen = hashes.map((hash) => { return String(hash).slice(0, length) })
    if (new Set(seen).size === hashes.length) return length
  }
  return 40
}

// Commits are keyed by short hash, but the agent does not always echo one back:
// commit bodies quote full hashes, and read_commit accepts either, so nothing
// teaches it to abbreviate. Matching only on the exact key read a correct answer
// as a missing commit, which sent whole releases through the literal-entry
// deterministic path. Anything that identifies one commit resolves here.
//
// A longer hash matches the key it starts with. Keys are lengthened past seven
// characters when two commits in a release collide, so the key length is not fixed.
function resolveHash(value, byHash) {
  const text = String(value === undefined || value === null ? '' : value)
  const raw = text.trim().toLowerCase()
  if (!raw) return ''
  if (byHash.has(raw)) return raw

  const matches = [...byHash.keys()].filter((hash) => {
    return hash.startsWith(raw) || raw.startsWith(hash)
  })
  return matches.length === 1 ? matches[0] : ''
}

export {
  build
, resolveHash
, toPayloadEntry
}
