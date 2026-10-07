import {IMPORTANCE_LEVELS} from './constants.js'
import {commitUrl, compareUrl, issueLink} from './repository.js'

// The model never emits markdown. It returns structured fields, and this
// module lays them out. Given the same structured input the output is
// byte-identical every time.
function render(normalized, context, options, repository) {
  return options.entryStyle === 'conventional'
    ? renderConventional(normalized, context, options, repository)
    : renderProse(normalized, context, options, repository)
}

// Byte-compatible with conventional-changelog-angular as
// @semantic-release/release-notes-generator runs it. Blocks are separated by two
// blank lines, entries are `*` bullets, and the agent's headline stands where the
// commit subject did.
function renderConventional(normalized, context, options, repository) {
  const {heading, subheading} = headings(context, options)
  const blocks = [`${heading} ${title(context, options, repository)}`]

  const grouped = group(normalized.entries, options)
  for (const section of options.sections) {
    const entries = grouped.get(section.id)
    if (!entries || !entries.length) continue

    const notes = section.id === options.breakingSection
      && options.breakingPlacement === 'restate'
    const lines = entries.map((entry) => {
      return notes
        ? conventionalNote(entry, options)
        : conventionalLine(entry, options, repository)
    })
    blocks.push(`${subheading} ${section.title}\n\n${lines.join('\n')}`)
  }

  if (options.includeOmitted && normalized.omitted.length) {
    const lines = normalized.omitted.map((entry) => {
      const hashes = conventionalHashes([entry], options, repository)
      return `* ${entry.subject.replace(/\.$/, '')}${hashes} _(${entry.reason})_`
    })
    blocks.push(`${subheading} Also in this release\n\n${lines.join('\n')}`)
  }

  return `${blocks.join('\n\n\n')}\n`
}

// Angular's commit line, `* **scope:** subject ([hash](url)), closes [#12](url)`.
// A grouped entry links each of its commits inside the one pair of parentheses.
function conventionalLine(entry, options, repository) {
  const scope = entry.scope ? `**${entry.scope}:** ` : ''
  const headline = entry.headline.replace(/\.$/, '')
  const hashes = conventionalHashes(entry.commits, options, repository)
  const closes = conventionalReferences(entry.references, options, repository)
  return `* ${scope}${headline}${hashes}${closes}${annotate(entry, options)}`
}

// Angular's note line under BREAKING CHANGES carries no links.
function conventionalNote(entry, options) {
  const scope = entry.scope ? `**${entry.scope}:** ` : ''
  return `* ${scope}${entry.headline}${annotate(entry, options)}`
}

// With links off, or no repository to link into, Angular prints the bare hash.
function conventionalHashes(commits, options, repository) {
  if (!commits.length) return ''
  const linked = options.includeCommitLinks && repository.browseUrl
  const parts = commits.map((commit) => {
    if (!linked) return commit.hash
    return `[${commit.hash}](${commitUrl(repository, commit.fullHash || commit.hash)})`
  })
  return linked ? ` (${parts.join(', ')})` : ` ${parts.join(', ')}`
}

function conventionalReferences(references, options, repository) {
  if (!references.length) return ''
  const parts = references.map((reference) => {
    const {text, url} = issueLink(repository, reference)
    return options.includeCommitLinks && url ? `[${text}](${url})` : text
  })
  return `, closes ${parts.join(' ')}`
}

// One flowing bullet per entry: lead sentence, supporting sentences, trailing
// reference. Keep a Changelog style.
function renderProse(normalized, context, options, repository) {
  const {heading, subheading} = headings(context, options)
  const lines = []

  lines.push(`${heading} ${title(context, options, repository)}`)
  lines.push('')

  const grouped = group(normalized.entries, options)
  for (const section of options.sections) {
    const entries = grouped.get(section.id)
    if (!entries || !entries.length) continue

    lines.push(`${subheading} ${section.title}`)
    lines.push('')
    for (const entry of entries) {
      lines.push(proseEntry(entry, options, repository))
    }
    lines.push('')
  }

  if (options.includeOmitted && normalized.omitted.length) {
    lines.push(`${subheading} Also in this release`)
    lines.push('')
    for (const entry of normalized.omitted) {
      const link = options.includeCommitLinks
        ? linkFor([{hash: entry.hash, fullHash: entry.fullHash}], repository)
        : ''
      lines.push(`- ${entry.subject}${link} _(${entry.reason})_`)
    }
    lines.push('')
  }

  // Trailing blank lines are collapsed so the document always ends with
  // exactly one newline.
  return `${lines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd()}\n`
}

function proseEntry(entry, options, repository) {
  const lead = entry.headline ? `**${entry.headline}**` : ''
  const body = [lead, ...entry.details].filter(Boolean).join(' ')
  const trailer = trailerFor(entry, options, repository)
  return `- ${body}${trailer}${annotate(entry, options)}`
}

// Prose entries cite the issue or PR the change belongs to, falling back to
// commit links only when the commits carry no references.
function trailerFor(entry, options, repository) {
  if (entry.references.length) return ` (${entry.references.join(', ')})`
  return options.includeCommitLinks ? linkFor(entry.commits, repository) : ''
}

// Annotations are for tuning. Importance is normally conveyed by the ordering,
// and confidence only matters when it is below high.
function annotate(entry, options) {
  const notes = []
  if (options.includeImportance) notes.push(entry.importance)
  if (options.includeConfidence && entry.confidence !== 'high') {
    notes.push(`${entry.confidence} confidence`)
  }
  return notes.length ? ` _(${notes.join(', ')})_` : ''
}

// A grouped entry links every commit it covers, so the mapping back to git
// survives grouping.
function linkFor(commits, repository) {
  const parts = commits.map((commit) => {
    const hash = commit.fullHash || commit.hash
    const url = commitUrl(repository, hash)
    return url ? `[\`${commit.hash}\`](${url})` : `\`${commit.hash}\``
  })
  return parts.length ? ` (${parts.join(', ')})` : ''
}

// `commit` has no entry so the agent's own order survives.
const COMPARATORS = {
  importance: byImportance
, scope: byScopeThenHeadline
}

function group(entries, options) {
  const grouped = new Map()

  for (const entry of entries) {
    // Only configured sections are rendered, so anything else would vanish.
    // Re-home it rather than drop it.
    const section = options.sectionIds.includes(entry.section)
      ? entry.section
      : options.fallbackSection
    if (!grouped.has(section)) grouped.set(section, [])
    grouped.get(section).push(entry)
  }

  const comparator = COMPARATORS[options.entryOrder]
  if (comparator) {
    for (const list of grouped.values()) {
      list.sort(comparator)
    }
  }

  return grouped
}

// Most important first, then the scope ordering, so equally important entries
// still land in a stable, readable order.
// Pinned to one locale so CI and a laptop order entries identically.
function compare(a, b) {
  return a.localeCompare(b, 'en')
}

function byImportance(a, b) {
  const rank = IMPORTANCE_LEVELS.indexOf(a.importance)
    - IMPORTANCE_LEVELS.indexOf(b.importance)
  return rank || byScopeThenHeadline(a, b)
}

// Entries without a scope sort last so named components lead each section.
function byScopeThenHeadline(a, b) {
  if (a.scope !== b.scope) {
    if (!a.scope) return 1
    if (!b.scope) return -1
    return compare(a.scope, b.scope)
  }
  return compare(a.headline, b.headline)
}

function title(context, options, repository) {
  const last = context.lastRelease || {}
  const next = context.nextRelease || {}
  const version = next.version || ''
  const date = new Date().toISOString().slice(0, 10)
  const compare = options.linkCompare
    ? compareUrl(repository, last.gitTag || last.gitHead, next.gitTag || next.gitHead)
    : ''
  const versionLink = compare ? `[${version}](${compare})` : version

  return options.title
    .replaceAll('{versionLink}', versionLink)
    .replaceAll('{version}', version)
    .replaceAll('{date}', date)
    .trim()
}

// `auto` is Angular's rule. A patch release is `##` and anything else is `#`,
// with sections always at `###`.
function headings(context, options) {
  if (options.headingLevel !== 'auto') {
    return {
      heading: '#'.repeat(options.headingLevel)
    , subheading: '#'.repeat(Math.min(options.headingLevel + 1, 6))
    }
  }

  const version = (context.nextRelease && context.nextRelease.version) || ''
  const patch = /^\d+\.\d+\.(\d+)/.exec(version)
  return {
    heading: patch && Number(patch[1]) !== 0 ? '##' : '#'
  , subheading: '###'
  }
}

export {
  render
}
