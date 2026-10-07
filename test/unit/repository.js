import {test} from 'tap'

import {commitUrl, compareUrl, describe, issueLink} from '../../lib/repository.js'

test('describe() normalizes every remote form to a browsable url', async (t) => {
  const cases = [
    ['https://github.com/mezmo/repo.git', 'https://github.com/mezmo/repo/commit/abc']
  , ['git+ssh://git@github.com/mezmo/repo.git', 'https://github.com/mezmo/repo/commit/abc']
  , ['git@github.com:mezmo/repo.git', 'https://github.com/mezmo/repo/commit/abc']
  , ['https://gitlab.com/group/repo', 'https://gitlab.com/group/repo/commit/abc']
  ]

  for (const [input, expected] of cases) {
    t.equal(commitUrl(describe(input), 'abc'), expected, input)
  }
})

test('describe() uses the bitbucket commit path', async (t) => {
  const repository = describe('git@bitbucket.org:team/repo.git')
  t.equal(repository.host.commit, 'commits')
  t.equal(commitUrl(repository, 'abc'), 'https://bitbucket.org/team/repo/commits/abc')
})

test('describe() preserves a non-default port on self-hosted remotes', async (t) => {
  const repository = describe('https://gitlab.example.com:8443/group/sub/proj.git')
  t.equal(commitUrl(repository, 'abc'), 'https://gitlab.example.com:8443/group/sub/proj/commit/abc')
})

test('describe() degrades to no link on an absent or bad url', async (t) => {
  t.equal(commitUrl(describe(''), 'abc'), '')
  t.equal(commitUrl(describe('not a url at all'), 'abc'), '')
})

test('describe() picks per-host reference prefixes', async (t) => {
  t.same(describe('https://github.com/a/b').host.issuePrefixes, ['#', 'gh-'])
  t.same(describe('https://gitlab.com/a/b').host.issuePrefixes, ['#'])
})

test('describe() handles an scp remote with no user prefix', async (t) => {
  t.equal(
    commitUrl(describe('github.com:mezmo/repo.git'), 'abc')
  , 'https://github.com/mezmo/repo/commit/abc'
  )
})

test('describe() keeps an explicit http remote on http', async (t) => {
  t.equal(
    commitUrl(describe('http://git.internal/team/repo.git'), 'abc')
  , 'http://git.internal/team/repo/commit/abc'
  )
})

test('describe() copes with a remote that has no path segments', async (t) => {
  const repository = describe('https://github.com')
  t.equal(repository.owner, '')
  t.equal(repository.repository, '')
})

test('describe() gives no browse url to a remote with no host', async (t) => {
  // A file:// remote parses, so a truthy url passed the guard and rendered links
  // pointing at somebody's laptop.
  t.equal(describe('file:///Users/me/repo').browseUrl, '')
  t.equal(describe('https://github.com/a/b.git').browseUrl, 'https://github.com/a/b')
})

test('issueLink() links the references Angular links and leaves the rest', async (t) => {
  const repository = describe('git@github.com:mezmo/repo.git')
  const issues = 'https://github.com/mezmo'

  t.same(issueLink(repository, '#12'), {text: '#12', url: `${issues}/repo/issues/12`})
  t.same(issueLink(repository, 'gh-7'), {text: '#7', url: `${issues}/repo/issues/7`})
  t.same(
    issueLink(repository, 'mezmo/rig#3')
  , {text: 'mezmo/rig#3', url: `${issues}/rig/issues/3`}
  )
  t.same(issueLink(repository, 'LOG-4821'), {text: 'LOG-4821', url: ''}, 'stays text')
  t.same(issueLink(describe(''), '#12'), {text: '#12', url: ''}, 'no repository, no link')
})

test('describe() applies release-notes-generator link overrides', async (t) => {
  const repository = describe('git@github.com:mezmo/repo.git', {
    host: 'https://git.example.com/'
  , commit: 'commits'
  , issue: 'issue'
  })

  t.equal(
    commitUrl(repository, 'abc')
  , 'https://git.example.com/mezmo/repo/commits/abc'
  )
  t.equal(issueLink(repository, '#2').url, 'https://git.example.com/mezmo/repo/issue/2')
})

test('describe() has no origin for a remote with no host', async (t) => {
  const repository = describe('file:///srv/repo.git')
  t.equal(repository.origin, '')
  t.equal(commitUrl(repository, 'abc'), '')
})

test('compareUrl() needs a repository and both tags', async (t) => {
  const repository = describe('https://github.com/mezmo/repo.git')
  t.equal(
    compareUrl(repository, 'v1.0.0', 'v1.1.0')
  , 'https://github.com/mezmo/repo/compare/v1.0.0...v1.1.0'
  )
  t.equal(compareUrl(repository, '', 'v1.1.0'), '', 'a first release has no compare')
  t.equal(compareUrl(describe(''), 'v1.0.0', 'v1.1.0'), '')
})

