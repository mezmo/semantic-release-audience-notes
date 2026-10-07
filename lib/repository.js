// Host table and URL normalization mirror @semantic-release/release-notes-generator
// so commit links match what the conventional generator would have produced.
// Its lib/hosts-config.js is not exported, so the table is reproduced here.
const HOSTS = [
  {
    hostname: 'github.com'
  , commit: 'commit'
  , issue: 'issues'
  , referenceActions: [
      'close', 'closes', 'closed', 'fix', 'fixes', 'fixed'
    , 'resolve', 'resolves', 'resolved'
    ]
  , issuePrefixes: ['#', 'gh-']
  }
, {
    hostname: 'bitbucket.org'
  , commit: 'commits'
  , issue: 'issue'
  , referenceActions: [
      'close', 'closes', 'closed', 'closing', 'fix', 'fixes', 'fixed', 'fixing'
    , 'resolve', 'resolves', 'resolved', 'resolving'
    ]
  , issuePrefixes: ['#']
  }
, {
    hostname: 'gitlab.com'
  , commit: 'commit'
  , issue: 'issues'
  , referenceActions: [
      'close', 'closes', 'closed', 'closing'
    , 'fix', 'fixes', 'fixed', 'fixing'
    ]
  , issuePrefixes: ['#']
  }
]

const DEFAULT_HOST = {
  hostname: ''
, commit: 'commit'
, issue: 'issues'
, referenceActions: [
    'close', 'closes', 'closed', 'closing', 'fix', 'fixes', 'fixed', 'fixing'
  , 'resolve', 'resolves', 'resolved', 'resolving'
  ]
, issuePrefixes: ['#', 'gh-']
}

const SCP_REGEX = /^(?!.+:\/\/)(?:(?<auth>.*)@)?(?<host>.*?):(?<path>.*)$/

// Resolves a git remote (https, ssh, or scp-style) into the pieces needed to
// build browsable commit and issue links. `overrides` takes release-notes-
// generator's `host`, `commit` and `issue` options, which replace the link origin
// and the two path segments.
function describe(repositoryUrl, overrides = {}) {
  const empty = {
    origin: ''
  , browseUrl: ''
  , hostname: ''
  , owner: ''
  , repository: ''
  , host: DEFAULT_HOST
  }
  if (!repositoryUrl) return empty

  const trimmed = String(repositoryUrl).replace(/\.git$/i, '')
  const scp = SCP_REGEX.exec(trimmed)

  let parsed
  try {
    parsed = new URL(
      scp
        ? `ssh://${scp.groups.auth ? `${scp.groups.auth}@` : ''}${scp.groups.host}/${scp.groups.path}`
        : trimmed
    )
  } catch {
    return empty
  }

  const protocol = parsed.protocol && /^http:/.test(parsed.protocol) ? 'http' : 'https'
  const port = parsed.protocol.includes('ssh') ? '' : parsed.port
  const authority = port ? `${parsed.hostname}:${port}` : parsed.hostname

  const segments = /^\/(?<owner>[^/]+)?\/?(?<repository>.+)?$/.exec(parsed.pathname)
  const known = HOSTS.find((entry) => {
    return entry.hostname === parsed.hostname
  }) || DEFAULT_HOST
  const host = {
    ...known
  , commit: overrides.commit || known.commit
  , issue: overrides.issue || known.issue
  }
  const origin = overrides.host
    ? overrides.host.replace(/\/+$/, '')
    : (authority ? `${protocol}://${authority}` : '')

  return {
    origin
  , browseUrl: origin ? `${origin}${parsed.pathname}` : ''
  , hostname: parsed.hostname
  , owner: (segments && segments.groups.owner) || ''
  , repository: (segments && segments.groups.repository) || ''
  , host
  }
}

// Matches the issue references Angular links, `#12` and `owner/repo#12`. Other
// prefixes, such as a JIRA key, are left as text.
const ISSUE_REF_REGEX = /^(?:(?<slug>[^\s#/]+\/[^\s#/]+))?(?:#|gh-)(?<issue>\d+)$/i

// Returns the reference as Angular prints it and the URL it links to, or an
// empty URL when the reference is not an issue on a known host.
function issueLink(repository, reference) {
  const match = ISSUE_REF_REGEX.exec(reference)
  if (!match) return {text: reference, url: ''}

  const {slug, issue} = match.groups
  const text = `${slug || ''}#${issue}`
  if (!repository.origin) return {text, url: ''}

  const path = slug || `${repository.owner}/${repository.repository}`
  return {text, url: `${repository.origin}/${path}/${repository.host.issue}/${issue}`}
}

// Angular links the version to a compare view whenever both tags are known, on
// every host.
function compareUrl(repository, previousTag, currentTag) {
  if (!repository.browseUrl || !previousTag || !currentTag) return ''
  return `${repository.browseUrl}/compare/${previousTag}...${currentTag}`
}

function commitUrl(repository, hash) {
  if (!repository.browseUrl) return ''
  return `${repository.browseUrl}/${repository.host.commit}/${hash}`
}

export {
  describe
, commitUrl
, compareUrl
, issueLink
}
