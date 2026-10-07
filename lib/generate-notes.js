import {build as buildPayload} from './commits.js'
import {createAgent as defaultCreateAgent} from './agent.js'
import {describe} from './repository.js'
import {bounded, fromCommit, normalize as normalizeEntries} from './entries.js'
import {AudienceNotesError} from './error.js'
import {assertApiKey, normalize as normalizeOptions} from './options.js'
import {render} from './render.js'

function createGenerateNotes(deps = {}) {
  const createAgent = deps.createAgent || defaultCreateAgent

  return async function generateNotes(pluginConfig, context) {
    const logger = context.logger || {log() {}, warn() {}, error() {}}
    const commits = context.commits || []

    if (!commits.length) return ''

    // Nothing here is caught. Release notes are written once, and a CI log on a
    // green build goes unread, so a run that cannot produce them stops the release
    // instead of shipping something that reads like an ordinary changelog.
    const options = normalizeOptions(pluginConfig, context)
    assertApiKey(options)

    const repository = describe(
      (context.options && context.options.repositoryUrl) || ''
    , {host: options.linkHost, commit: options.commitPath, issue: options.issuePath}
    )
    const payload = buildPayload(commits, options, context, repository)
    if (!payload.length) {
      logger.warn(
        `All ${commits.length} commits were filtered out before the agent ran.`
          + ' Check `commitOpts.ignore`.'
      )
      return ''
    }

    const agent = createAgent(options, deps)
    const resolved = await describing(agent, payload, context, logger)
    const normalized = normalizeEntries(resolved, options)

    renderForgotten(normalized, options, logger)

    logger.log(
      `Wrote ${normalized.entries.length} entries from ${payload.length} commits`
        + `, omitted ${normalized.omitted.length}`
        + ` (audience: ${options.audience.name})`
    )
    logDispositions(normalized, options, logger)
    return render(normalized, context, options, repository)
  }
}

// A commit the agent dropped and one it folded into another entry both read as
// coverage from the summary line alone. Naming them is what makes a run's
// judgement reviewable against the release rather than against the last run.
function logDispositions(normalized, options, logger) {
  if (!options.verbose) return

  for (const entry of normalized.omitted) {
    logger.log(`  omitted ${entry.hash} ${entry.subject} (${entry.reason})`)
  }
  for (const entry of normalized.entries) {
    if (!entry.supporting.length) continue
    logger.log(`  supporting ${entry.supporting.join(' ')} -> ${entry.headline}`)
  }
  for (const entry of normalized.dropped) {
    const hashes = entry.hashes.join(' ') || '(none)'
    logger.log(`  dropped ${hashes} (${entry.reason}) -> ${entry.headline}`)
  }
}

// Anything thrown here reaches semantic-release, which renders a code, a message
// and details only for an error carrying its flag, and dumps the raw object twice
// for anything else. An SDK error is exactly that: a sixty-line dump of undefined
// fields where one line would say the credentials were missing. The release still
// fails -- this decides how it reads.
async function describing(agent, payload, context, logger) {
  try {
    return await agent.describe(payload, context, logger)
  } catch (err) {
    if (err.semanticRelease) throw err
    throw new AudienceNotesError(
      'EAGENTFAILED'
    , `The release-notes agent failed: ${err.message}`
    , 'The release is stopped rather than published with the notes this plugin '
        + 'replaced. Re-run once the cause is fixed.'
    , err
    )
  }
}

// A commit the agent never described gets rendered from its subject line, which is
// the plugin failing at the one thing it exists for. It is reported as a failure
// rather than a note. One whose type has no section is listed as omitted, which
// is where the section table already sends that work.
function renderForgotten(normalized, options, logger) {
  if (!normalized.missing.length) return

  const hashes = normalized.missing.map((commit) => {
    return commit.hash
  }).join(', ')

  logger.error(
    `Wrote ${normalized.missing.length} commits as literal subjects because the`
      + ` agent never described them: ${hashes}`
  )
  for (const commit of normalized.missing) {
    const entry = fromCommit(commit, options)
    if (entry) {
      normalized.entries.push(entry)
      continue
    }
    normalized.omitted.push({
      hash: commit.hash
    , fullHash: commit.fullHash
    , subject: bounded(commit.subject)
    , reason: 'internal-only'
    })
  }
}

export {createGenerateNotes}
