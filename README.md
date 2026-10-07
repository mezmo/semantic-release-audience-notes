# semantic-release-audience-notes

Drop-in replacement for [`@semantic-release/release-notes-generator`][rng] that writes
human-readable, audience-targeted release notes. An agent navigates the repository, decides
which commits matter to the audience you name, groups the ones that deliver a single change,
and drops the noise.

```diff
  plugins: [
    ['@semantic-release/commit-analyzer', {}]
- , ['@semantic-release/release-notes-generator', {}]
+ , ['@mezmoinc/semantic-release-audience-notes', {audience: 'operators'}]
  , ['@semantic-release/changelog', {}]
  ]
```

Take a release with three commits: a breaking feature, a follow-up fix to it, and a
dependency bump. The fix folds into the feature's entry, which links both commits. The bump is
dropped because it changes nothing for the reader. The breaking change is restated for the
audience under BREAKING CHANGES.

```markdown
# [2.0.0](…/compare/v1.4.0...v2.0.0) (2026-09-11)


### Features

* **api-auth:** Sessions now expire 15 minutes after they are issued ([ba67342](…), [b03eef4](…)), closes [#12](…)


### BREAKING CHANGES

* **api-auth:** Anyone signed in for more than 15 minutes is signed out on deploy, so expect a burst of re-authentication traffic.
```

The layout is exactly what release-notes-generator writes. Only the words are different.

## Output

### Presets

`preset` picks a section table, an entry style, and where breaking changes land. Those three
have to agree, so one option sets all of them.

`conventional` is the default. It renders what release-notes-generator renders with its
default Angular preset, byte for byte. That covers the heading level, the compare link, the
section titles and order, the `*` bullets, the commit links, and the `closes` references. The
agent writes each line where Angular copies the commit subject. `angular` and `default` are
accepted as aliases.

| Preset | Sections | Entry style | Breaking changes |
|---|---|---|---|
| `conventional` (default) | Bug Fixes, Features, Performance Improvements, Reverts, BREAKING CHANGES | `conventional` | Restated under BREAKING CHANGES |
| `keepachangelog` | Added, Changed, Deprecated, Removed, Fixed, Security | `prose` | Kept where the agent files them |

`conventional` differs from the generator in five deliberate ways:

- One entry can cover several commits, and it links all of them in one pair of parentheses.
- The agent omits work the reader would not notice, where Angular hides commits by type.
- A `feat!:` commit with no `BREAKING CHANGE:` footer counts as breaking. Angular's parser misses it.
- A JIRA-style reference renders as text, where Angular turns it into a broken `#` link.
- `writerOpts`, `config` and `presetConfig` are ignored with a warning, because nothing here
  renders through a template.

The generator's `linkCompare`, `linkReferences`, `host`, `commit`, `issue` and `parserOpts`
options carry over unchanged. Angular's other groups, such as Documentation and Code
Refactoring, can be added with `extraSections`, as described under
[Optional sections](documentation/OPTIONS.md#optional-sections).

**`conventional`** renders one line per entry. Only the headline is shown.

```markdown
* **api-auth:** Sessions now expire 15 minutes after they are issued ([ba67342](…)), closes [#12](…)
```

**`prose`** renders one flowing bullet ending in the issue or PR it belongs to.

```markdown
- **Prompt caching for Anthropic and Bedrock.** Set `prompt_caching = true` under `[agent.llm]`. Cache writes bill at a premium, so it stays off until you turn it on. (#630)
```

For a [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) document, with the spec's
heading and its six sections:

```js
['@mezmoinc/semantic-release-audience-notes', {preset: 'keepachangelog', audience: 'developers'}]
```

Upgrade notes and For contributors are not in the spec. Add either with `extraSections`, as
described under [Optional sections](documentation/OPTIONS.md#optional-sections).

Everything a preset sets can be overridden individually — `sections`, `entryStyle`,
`breakingSection`, `actionSection`, `includeCommitLinks`, `entryOrder`, `title`,
`headingLevel`.

### Sections and commit types

The section table is configuration. Replace it and the agent's choices, the render order,
and the type fallback all follow.

Commit **type** only reaches the output on one deterministic path, a commit the agent
forgot. Normally the agent reads the commit and picks a section itself, so an unfamiliar
type like `svc:` costs nothing. If your convention goes beyond Angular's types, map the
extras so that path lands correctly.

```js
// With the conventional preset. Mezmo's commit convention allows 15 types;
// these are the ones that should render as features rather than be listed
// as omitted. Under keepachangelog the section is 'added'.
{
  typeSections: {
    lib: 'features'
  , src: 'features'
  , svc: 'features'
  }
}
```

For a different taxonomy entirely, replace the table. Array order is render order, `types`
feeds that path, and `description` tells the agent what the section means.

```js
{
  sections: [
    {id: 'breaking',  title: 'Breaking Changes', description: 'consumers must change something.'}
  , {id: 'services',  title: 'Services',         description: 'service behavior changed.', types: ['svc', 'lib', 'src']}
  , {id: 'pipeline',  title: 'Pipeline',         description: 'ingest or routing changed.',  types: ['pipeline']}
  , {id: 'internal',  title: 'Internal',         description: 'everything else.',            types: ['chore', 'ci', 'test']}
  ]
}
```

Three rules are checked at config time. Ids must be unique, `breakingSection` must name a
section that exists, and `actionSection` must name one or be empty. In a custom table, unknown
types fall to the `internal` section when one exists, otherwise the last section that is not
the breaking one. The default table has no fallback, because Angular has none. A forgotten
commit of an unmapped type is listed as omitted instead of rendered.

### Grouping and omission

Commits that deliver one change share one entry, and the agent decides which section it lands
in. A commit it judges uninteresting is dropped with a reason rather than silently — set
`includeOmitted: true` to render those in a trailing "Also in this release" section. A commit
that is neither described nor dropped is re-added from its subject, so nothing is lost by
accident.

**Breaking changes are never omittable.** If the commit parser flagged a commit breaking, it
reaches `breakingSection` whatever the agent decided and whoever the audience is. Under
`conventional` its entry stays in its own section and BREAKING CHANGES restates it. The agent
writes the restatement, and when it does not, the commit's `BREAKING CHANGE:` note stands in.
Under `keepachangelog` the entry stays where the agent filed it, usually Changed or Removed,
and a breaking commit the agent left out is filed in Changed. With the `upgrade` extra section
enabled, breaking entries move to Upgrade notes instead.

### Reader actions

`actionSection` names a section that answers what the reader has to do rather than what
changed, so one change can appear twice — once under what it is, once under what to do about
it. `conventional` points it at BREAKING CHANGES and accepts only breaking commits there.
`keepachangelog` has none, because the spec has none, until the `upgrade` extra section adds
Upgrade notes. Set `actionSection: ''` to turn it off.

### Output contract

```markdown
# [<version>](<compare url>) (<date>)


### Bug Fixes

* **<scope>:** <headline> ([<hash>](<url>), [<hash>](<url>)), closes [#918](<url>) LOG-4821


### BREAKING CHANGES

* **<scope>:** <what breaks and what to do>
```

The heading is `#` for a major or minor release and `##` for a patch, as in Angular. Set
`headingLevel` to pin it. The version links to a compare view when both tags are known.
Blocks are separated by two blank lines.

Sections render in the order of the configured table, empty ones omitted. The default order
runs `Bug Fixes` → `Features` → `Performance Improvements` → `Reverts` →
`BREAKING CHANGES` → `Also in this release`.

Within a section, entries sort by scope, with unscoped entries last, then by headline. Set
`entryOrder` to `importance` or `commit` to change that.

## Install

```sh
npm install --save-dev @mezmoinc/semantic-release-audience-notes
```

Requires Node `^22.14.0 || >=24.10.0`, the same as semantic-release 25, and a git repository.
The default provider needs an `ANTHROPIC_API_KEY`; Bedrock uses the AWS credential chain
instead.

## Usage

```js
// release.config.js
export default {
  branches: ['main']
, plugins: [
    ['@semantic-release/commit-analyzer', {}]
  , ['@mezmoinc/semantic-release-audience-notes', {audience: 'operators'}]
  , ['@semantic-release/changelog', {changelogTitle: '## Changelog'}]
  , ['@semantic-release/github', {}]
  ]
}
```

The plugin implements `verifyConditions` and `generateNotes`. Registering it is enough.
`verifyConditions` fails the run early on a bad config rather than after publishing.

### Audience

`audience` decides what gets emphasized *and what gets dropped*. A dependency bump is noise to
an end user and may be the whole story to a security engineer. Pass one of the
[audience presets](documentation/OPTIONS.md#audience-presets) or describe the reader in your
own words.

```js
{audience: 'Hospital schedulers who use the tablet app and never read a changelog'}
```

### Providers

Runs against the first-party Anthropic API by default, or Amazon Bedrock if that is where
your Claude access already lives.

```js
['@mezmoinc/semantic-release-audience-notes', {
  provider: 'bedrock'
, region: 'us-east-1'      // or AWS_REGION in the environment
}]
```

Bedrock needs its SDK, an optional dependency:

```sh
npm install --save-dev @anthropic-ai/bedrock-sdk
```

Five things differ under `bedrock`:

- **Credentials** come from the standard AWS chain — environment, `~/.aws`, instance role.
  `ANTHROPIC_API_KEY` is neither read nor required.
- **`region` is required.** It falls back to `AWS_REGION`, then `AWS_DEFAULT_REGION`. With
  none of them set, the run fails at config time.
- **Requests go to Bedrock's Mantle endpoint,** which has its own IAM actions. The identity
  needs `bedrock-mantle:CreateInference`, and `bedrock:InvokeModel` does not cover it. AWS's
  managed policy `AmazonBedrockMantleInferenceAccess` grants it, or scope it yourself:

  ```json
  {
    "Version": "2012-10-17",
    "Statement": [{
      "Effect": "Allow",
      "Action": "bedrock-mantle:CreateInference",
      "Resource": "arn:aws:bedrock-mantle:us-east-1:123456789012:project/*"
    }]
  }
  ```
- **The account needs access to Anthropic models.** Submit the use case form for an Anthropic
  model in the Bedrock console's model catalog, once per account. A 403 that names no IAM
  action means the account has no access to the model.
- **The model id is prefixed** automatically, so `claude-opus-5-5` becomes
  `anthropic.claude-opus-5-5`, the form Mantle serves. An id that already names the provider
  is passed as written. Mantle rejects cross-region inference profiles such as
  `us.anthropic.…` and ARNs with a 400 that names the model.

### Effort

`effort` sets how much of the code the agent reads before it writes. It never changes what
the notes must get right. At every level each commit is described or omitted, a breaking
change is never dropped, and a value the agent did not read is left out instead of guessed.

| Level | What the agent reads | Budget |
|---|---|---|
| `low` | Commit messages, and code only when a message does not say what changed | 10 tool calls, 2 details |
| `medium` | Also the diff of any commit whose message does not say what changed for the reader | 30 tool calls, 3 details |
| `high` *(default)* | Also the code behind each entry, for the values a reader acts on: defaults, limits, event fields, log messages | 60 tool calls, 4 details |
| `xhigh` | Also the code around each change, not only the diff | 120 tool calls, 4 details |
| `max` | Also where each change reaches the reader, such as the config key, the output or the endpoint | 200 tool calls, 4 details |

The level also goes to the model as its own effort setting, which sets how long it thinks
each turn. [Per-effort defaults](documentation/OPTIONS.md#per-effort-defaults) lists every
budget it sets.

- **Keep `high` for most projects.** Commit messages say what a developer did, and readers
  need what changed for them. `high` reads the code to close that gap and names the real
  defaults and limits.
- **Lower it when your commits already read like release notes.** That includes squash-merged
  pull requests whose descriptions are written for users, and teams that write a changelog
  line for each change. The agent then mostly groups, sorts and rewords, and reading code
  adds little. `low` is the fastest and cheapest, but its entries stay general, because it
  never names a value it did not read.
- **Raise it when a wrong or missing detail is expensive.** That includes security and
  compliance audiences, notes customers act on, operators who configure against these
  values, and releases full of behavior or breaking changes. `xhigh` and `max` read more
  around each change and cost more per run.

### Debugging a run

`verbose: true`, or `AUDIENCE_NOTES_VERBOSE`, logs one line per turn, tool call and submission
attempt:

```
turn 1: stop=tool_use in=25013 out=412
  read_commit {"hash":"22c7c05"} -> 553 chars
submission 1: 9 entries, 2 omitted, 0 unresolved, 0 unaccounted
```

## Options

Every option and its default is documented in
[documentation/OPTIONS.md](documentation/OPTIONS.md), along with the per-effort and per-preset
defaults.

## Failure behavior

A run that cannot produce notes fails the release. There is no degrade mode.

Notes are written once, and a warning on a green pipeline goes unread, so anything
that silently substituted ordinary changelog output would let a wrong key or an
unreachable region survive release after release looking like nothing had changed.

## Cost

A release takes several model requests. What it costs depends on how many commits it has
and how much code the agent reads. These runs used `high` on Opus 5.5, priced at Anthropic's
list rates:

| Release | Turns | Tool calls | Cost |
|---|---|---|---|
| 3 commits | 4 | 6–8 | $0.14–$0.19 |
| 14 commits | 3–6 | 7–10 | $0.22–$0.29 |
| 42 commits | 9 | 28 | $0.93 |

Lower efforts cap the agent at 10 or 30 tool calls and tell it to work from the commit
messages, so they spend less. Higher efforts allow 120 or 200 calls. Each run logs the tokens
it used. Bedrock bills at AWS's rates.

## Inherited commit conventions

Commits are parsed with [`conventional-commits-parser`][ccp] using your release config's own
`parserOpts`, so custom `issuePrefixes`, `noteKeywords`, `headerPattern`, and
`referenceActions` carry over. With Mezmo's `release-config-core`, JIRA references (`LOG-`,
`PROD-`, `SCT-`, `VM-`, `INFRA-`, `COM-`) and the `ref` trailer are picked up with no extra
configuration.

`commitOpts.ignore` is honored, commits reverted within the same release are dropped before
the agent sees them, and commit links use the right path per host — `/commit/` on GitHub and
GitLab, `/commits/` on Bitbucket — including scp-style and self-hosted remotes.

## Security

Every tool is read-only and scoped to one repository at one ref. `read_file` resolves
model-supplied paths and refuses anything outside the repo root. `grep` passes its pattern
through `execFile` as a single argv entry, never a shell string. Excluded paths are applied as
git pathspecs, and `read_file` checks the same globs, so a lockfile or `dist/` tree never
reaches the model at all. [SECURITY.md](SECURITY.md) lists what each run sends to the model
provider and how to report a vulnerability.

## Development

```sh
npm test              # lint + knip + tap, with 100% coverage thresholds
npm run tap:unit      # fast loop, no git subprocesses
npm run knip          # unused files, dependencies, and exports
npm run knip:production   # exports kept alive only by tests
npm run lint:fix
npm run release:dry   # semantic-release dry run; needs GITHUB_TOKEN and NPM_TOKEN
```

[CONTRIBUTING.md](CONTRIBUTING.md) covers the branch, commit and review workflow that CI
enforces.

The tests need no API key and no network. The integration tests run the real SDK against a
local stand-in for the Anthropic API, `test/fixtures/fake-api.js`.

`knip --production` reports exports that exist only for tests. Several pure helpers are
unit-tested directly, so that is legitimate here and it runs as a separate script.

[rng]: https://github.com/semantic-release/release-notes-generator
[ccp]: https://github.com/conventional-changelog/conventional-changelog/tree/master/packages/conventional-commits-parser
