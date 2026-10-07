# Options

Every option goes in the plugin's entry in the release config.

```js
['@mezmoinc/semantic-release-audience-notes', {audience: 'operators', effort: 'medium'}]
```

Defaults marked *per effort* or *per preset* are listed in the tables at the end.

## Audience and model

| Option | Default | Purpose |
|---|---|---|
| `audience` | `'developers'` | An [audience preset](#audience-presets), matched without regard to case, or free text describing the reader |
| `provider` | `'anthropic'` | `anthropic` or `bedrock` |
| `region` | `$AWS_REGION`, then `$AWS_DEFAULT_REGION` | AWS region; required for `bedrock` |
| `model` | `'claude-opus-5-5'` | Model id; prefixed with `anthropic.` under `bedrock` |
| `effort` | `'high'` | `low`, `medium`, `high`, `xhigh` or `max` |
| `apiKeyEnv` | `'ANTHROPIC_API_KEY'` | Env var holding the key; the key itself is never read from config |
| `baseUrl` | `$ANTHROPIC_BASE_URL` | Override the API host; ignored under `bedrock` |
| `promptCaching` | `true` | Cache between turns; leave on unless the model rejects cache points |
| `maxRetries` | `3` | SDK retry count |
| `timeout` | `600000` | How long in ms to wait for a response to start, and then for each part of the streamed response. At most ten minutes |

## Agent budget

| Option | Default | Purpose |
|---|---|---|
| `agent.maxIterations` | per effort | Agent loop turns before giving up |
| `agent.maxToolCalls` | per effort | Read-tool budget for the whole run |
| `agent.maxTokens` | per effort | Output cap per turn |
| `introspect.exclude` | [listed below](#default-excludes) | Paths the read tools never surface |

`effort` sets all three. The read tools' size caps are fixed, and `agent` and `introspect`
reject any key not listed here.

## Layout

| Option | Default | Purpose |
|---|---|---|
| `preset` | `'conventional'` | `conventional` (aliases `angular`, `default`) or `keepachangelog`. Any other name renders as `conventional` with a warning, because a shared release config sets `preset` for commit-analyzer too |
| `entryStyle` | per preset | `conventional` or `prose` |
| `entryOrder` | per preset | `importance`, `scope` or `commit` |
| `title` | per preset | Heading template; `{version}`, `{versionLink}`, `{date}` (`YYYY-MM-DD`) |
| `headingLevel` | per preset | `'auto'` (Angular's rule) or `1`–`4` |
| `includeOmitted` | `false` | Render omitted commits in a trailing section |
| `includeConfidence` | `false` | Annotate entries below high confidence |
| `includeImportance` | `false` | Annotate each entry with its grade |
| `limits` | `scope` 32, `headline` per preset, `detail` 260, `maxDetails` per effort | Length targets given to the model |

`headline` and `detail` are targets stated in the prompt. Nothing cuts an overshoot, and
`maxDetails` bounds the entry instead. `scope` is enforced, because a scope is an identifier.
Only the `prose` style renders detail sentences.

## Sections

| Option | Default | Purpose |
|---|---|---|
| `sections` | per preset | Replace the section table wholesale |
| `extraSections` | `[]` | Add a preset's [optional sections](#optional-sections) to its table |
| `typeSections` | `{}` | Map extra commit types onto existing sections |
| `breakingSection` | per preset | Section breaking changes reach |
| `actionSection` | per preset | Section whose entries restate changes as reader actions, `''` for none |

## Links

The names in this group match release-notes-generator's, so its config carries over.

| Option | Default | Purpose |
|---|---|---|
| `includeCommitLinks` | per preset | Render commit and issue links; `linkReferences` is an alias |
| `linkCompare` | `true` | Link the version in the heading to a compare view |
| `host` | from the remote | Origin for every link, such as `https://git.example.com` |
| `commit` | per host | Path segment for commit links |
| `issue` | per host | Path segment for issue links |

## Commit selection and parsing

| Option | Default | Purpose |
|---|---|---|
| `parserOpts` | release config's | Merged over the release config's `parserOpts` |
| `commitOpts` | release config's | Merged over the release config's `commitOpts`; commits matching the `ignore` regex never reach the agent |

## Debugging

| Option | Default | Purpose |
|---|---|---|
| `verbose` | `$AUDIENCE_NOTES_VERBOSE` | Log every turn, tool call and submission |
| `extraGuidance` | `''` | Extra text appended to the system prompt |

## Audience presets

A preset name stands in for the description the agent is given. Free text is given to the
agent as written, so describe the reader the way you would to a colleague writing the notes.

| Preset | Description given to the agent |
|---|---|
| `developers` *(default)* | Application developers who consume this package or service as a dependency. |
| `operators` | Operators and SREs who deploy, monitor, and troubleshoot this in production. |
| `end-users` | Non-technical end users of the product interacting through its UI. |
| `executives` | Business stakeholders tracking delivery risk, customer impact, and commitments. |
| `security` | Security engineers reviewing changes for exposure, hardening, and compliance impact. |
| `support` | Support engineers who answer customer questions and triage incoming reports. |

```js
{audience: 'Hospital schedulers who use the tablet app and never read a changelog'}
```

## Default excludes

`introspect.exclude` takes gitignore-style globs. A string is one glob, and an array is a
list. Either replaces the defaults rather than adding to them, so copy any you want to keep.

```js
[
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
```

An excluded path never reaches the model. Diffs, a commit's file list and searches skip it,
and `read_file` refuses it.

## Per-effort defaults

`effort` tunes how much work a run does. It never tunes whether the output is correct.

| | `low` | `medium` | `high` *(default)* | `xhigh` | `max` |
|---|---|---|---|---|---|
| `limits.maxDetails` | 2 | 3 | 4 | 4 | 4 |
| `agent.maxToolCalls` | 10 | 30 | 60 | 120 | 200 |
| `agent.maxIterations` | 15 | 25 | 40 | 70 | 120 |
| `agent.maxTokens` | 8k | 12k | 24k | 32k | 48k |

Explicit config wins over these. `maxToolCalls` is a ceiling and not a target.

## Per-preset defaults

| | `conventional` *(default)* | `keepachangelog` |
|---|---|---|
| `entryStyle` | `conventional` | `prose` |
| `entryOrder` | `scope` | `importance` |
| `title` | `'{versionLink} ({date})'` | `'{versionLink} - {date}'` |
| `headingLevel` | `'auto'` | `2` |
| `includeCommitLinks` | `true` | `false` |
| `limits.headline` | `200` | `120` |
| `breakingSection` | `breaking` | `changed` |
| `actionSection` | `breaking` | `''` |
| `sections` | [`conventional` table](#conventional) | [`keepachangelog` table](#keepachangelog) |

Each preset follows its convention exactly: `conventional` follows Angular as
release-notes-generator runs it, and `keepachangelog` follows
[Keep a Changelog 1.1.0](https://keepachangelog.com/en/1.1.0/).

## Section tables

`typeSections`, `breakingSection` and `actionSection` take a section's id. The agent picks
each entry's section from the descriptions below. Commit types only decide where a commit
the agent forgot is filed, and where `typeSections` points a custom type.

### `conventional`

| Id | Title | Commit types | Description given to the agent |
|---|---|---|---|
| `fixes` | Bug Fixes | `fix`, `bugfix` | the change corrects behavior that was already meant to work. |
| `features` | Features | `feat`, `feature` | the change adds a capability that did not exist before. |
| `performance` | Performance Improvements | `perf` | the change alters speed, throughput, memory, or cost with no behavior change. |
| `reverts` | Reverts | `revert` | the change undoes a commit from an earlier release. |
| `breaking` | BREAKING CHANGES | — | restates a breaking change described in another section as what breaks and what the reader must do. |
| `docs` | Documentation *(optional)* | `docs`, `doc` | the change only affects documentation, comments, or examples. |
| `style` | Styles *(optional)* | `style` | the change only affects formatting, with no change in behavior. |
| `refactor` | Code Refactoring *(optional)* | `refactor` | the change restructures code without changing what it does. |
| `test` | Tests *(optional)* | `test`, `tests` | the change only adds or corrects tests. |
| `build` | Build System *(optional)* | `build` | the change affects the build, packaging, or dependencies. |
| `ci` | Continuous Integration *(optional)* | `ci` | the change affects CI configuration or scripts. |
| `chore` | Miscellaneous Chores *(optional)* | `chore` | routine maintenance that fits no other section. |

### `keepachangelog`

| Id | Title | Commit types | Description given to the agent |
|---|---|---|---|
| `added` | Added | `feat`, `feature` | a capability that did not exist before. |
| `changed` | Changed | `refactor`, `perf`, `style` | existing behavior works differently now. |
| `deprecated` | Deprecated | `deprecate`, `deprecation` | something still works but is marked for removal in a future release. |
| `removed` | Removed | `remove` | something that existed is gone. |
| `fixed` | Fixed | `fix`, `bugfix`, `revert` | behavior that was already meant to work now does. |
| `security` | Security | `security` | the change closes a vulnerability or hardens against one. |
| `upgrade` | Upgrade notes *(optional)* | — | the reader must do something to adopt this release, such as a changed default, a migration, a compatibility break, or a size or cost change. |
| `contributors` | For contributors *(optional)* | `ci`, `build`, `chore`, `test`, `tests` | only matters to someone working on this repository, covering build times, CI, dependency plumbing, and the release process. |

A commit whose type no row lists has no section, and the agent omits it.

## Optional sections

Sections a preset leaves out by default are added with `extraSections`, listed by id. The
[section tables](#section-tables) mark them *(optional)*.

`conventional` offers the groups Angular hides unless a commit in them is breaking, with the
titles Angular and `conventional-changelog-conventionalcommits` give them. They sort in by
title, as Angular orders its groups, and BREAKING CHANGES stays last.

```js
{extraSections: ['docs', 'refactor']}
```

`keepachangelog` offers two sections the spec does not have. They render after the spec's
six, Upgrade notes first.

| Id | Effect |
|---|---|
| `upgrade` | Holds reader actions, and breaking changes move here |
| `contributors` | Holds CI, build and release work, and any commit whose type has no section |

```js
{preset: 'keepachangelog', extraSections: ['upgrade', 'contributors']}
```

`extraSections` adds to a preset's own table, so it cannot be combined with `sections`.
