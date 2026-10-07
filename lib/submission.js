import {resolveHash} from './commits.js'
import {normalize} from './entries.js'

const FEATURE_TYPES = new Set(['feat', 'feature'])

// The one place an agent-supplied hash becomes a commit.
//
// Resolving a hash anywhere else means every site deciding for itself what an
// unmatched one means, and a submission naming its commits in a form we do not
// accept then looks exactly like an agent that forgot them. Past this boundary
// there are no hashes to mishandle. Entries carry commits,
// omissions carry a commit, and anything that named nothing is in `unresolved`
// where it cannot be mistaken for a judgement the agent made.
// A conventional type is the only signal available here, and it only has to be
// right about the two kinds of change that must never be silently absorbed.
function isFeature(commit) {
  return FEATURE_TYPES.has(String(commit.type || '').toLowerCase())
}

function resolve(result, payload) {
  const byHash = new Map(payload.map((commit) => {
    return [commit.hash, commit]
  }))
  const unresolved = []

  // The submit tool's schema constrains these, but a boundary that trusts its
  // input is not a boundary.
  function listOf(value) {
    return Array.isArray(value) ? value : []
  }

  function lookup(value) {
    const hash = resolveHash(value, byHash)
    if (hash) return byHash.get(hash)
    unresolved.push(String(value === undefined || value === null ? '' : value))
    return null
  }

  const entries = listOf(result && result.entries).map((raw) => {
    const seen = new Set()

    // Naming one commit twice in the same entry is a typo, not a second claim.
    function claim(values) {
      const commits = []
      for (const value of values) {
        const commit = lookup(value)
        if (!commit || seen.has(commit.hash)) continue
        seen.add(commit.hash)
        commits.push(commit)
      }
      return commits
    }

    const commits = claim(listOf(raw && raw.hashes))
    const supporting = []

    // Supporting means the reader never ran the state this commit changed. A
    // breaking change or a new capability is something they experience whatever
    // else it was in service of, so refusing the demotion promotes the commit to a
    // full member of the entry. Dropping it instead would report it as forgotten,
    // which is the confusion this boundary exists to prevent.
    for (const commit of claim(listOf(raw && raw.supporting))) {
      if (commit.breaking || isFeature(commit)) commits.push(commit)
      else supporting.push(commit)
    }

    // An entry has to be about something. With nothing but supporting commits
    // there is no change for them to support, so they are the change.
    if (!commits.length) commits.push(...supporting.splice(0))

    return {...raw, commits, supporting}
  })

  const omitted = listOf(result && result.omitted).map((raw) => {
    return {...raw, commit: lookup(raw && raw.hash)}
  }).filter((entry) => {
    return entry.commit
  })

  return {
    entries
  , omitted
  , unresolved
  , payload
  }
}

// Commits the submission named nowhere. Deliberately not "commits we failed to
// resolve" -- that is `unresolved`, and conflating the two is what let a broken
// lookup masquerade as an agent that forgot half the release.
// The gate has to model the renderer or it waves through a submission the
// renderer then mangles. Counting a commit as accounted because it was named
// anywhere let one carried only as `supporting` on an entry the one-claim rail
// later dropped reach the document as a bare subject.
function unaccounted(resolved, options) {
  return audit(resolved, options).missing
}

// What the renderer would leave out: commits named nowhere it counts, and the
// entries its rails drop. A dropped entry is why a commit the agent did name can
// still be missing, so the agent is told both.
function audit(resolved, options) {
  const normalized = normalize(resolved, options)
  return {
    missing: normalized.missing.map((commit) => { return commit.hash })
  , dropped: normalized.dropped
  }
}

export {
  audit
, resolve
, unaccounted
}
