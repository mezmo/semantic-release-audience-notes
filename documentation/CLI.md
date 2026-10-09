# audience-notes CLI

`audience-notes` renders the release notes this plugin would write for any commit range, without
running a release, tagging, or touching the target repository's config. It runs the same
`generateNotes` code path semantic-release would. The agent's wording varies from run to run,
so it shows the kind of notes a release would publish rather than the exact text.

## Running it

Without installing:

```sh
npx -p @mezmoinc/semantic-release-audience-notes audience-notes --from v1.4.0
```

After `npm install --save-dev @mezmoinc/semantic-release-audience-notes`:

```sh
npx audience-notes --from v1.4.0
```

Always name the package with `-p` unless it is installed. A bare `npx audience-notes` in a
project without it asks npm for an unrelated package called `audience-notes`.

Requires Node `^22.14.0 || >=24.10.0` and `git` on the `PATH`.

## Quick start

```sh
# 1. Check the range and the config. No model call, no cost.
npx audience-notes --from v1.4.0 --json

# 2. Render the notes for everything since v1.4.0.
npx audience-notes --from v1.4.0 --audience operators

# 3. Save them.
npx audience-notes --from v1.4.0 --audience operators > NOTES.md
```

## What it reads

| Input | Source |
|---|---|
| Commits | `git log <from>..<to>` in `--cwd`, merges included |
| Repository URL | `git remote get-url origin`; links are omitted when there is no `origin` |
| Package name | `name` in `--cwd`'s `package.json`, if it has one |
| Previous release | `--from`; a `v` before a digit is stripped for the version |
| Next release | `--version` for the heading, `--to` as its tag |
| Plugin options | `--config`, then flags on top |
| Credentials | Environment, see [Credentials](#credentials) |

The range follows git's `a..b` rule. `--from` is excluded and `--to` is included, so
`--from v1.4.0 --to v1.5.0` covers exactly what shipped in 1.5.0. Without `--from` the run
covers every commit up to `--to`, the way a first release does.

`--to` resolves to a commit when the run starts, so a branch that moves during a long run
does not change what the agent reads.

When `--cwd` is a subdirectory of the repository, such as a package in a monorepo, the run
reads only the commits that touched it. The agent's tools see only that directory too.

## Flags

A flag takes its value as the next argument or after `=`, so `--from v1.4.0` and
`--from=v1.4.0` are the same. An unknown flag, a flag with no value, or an argument that is
not a flag fails the run before any work starts.

These flags belong to the CLI:

| Flag | Default | Purpose |
|---|---|---|
| `--from <ref>` | none, so every commit | First ref not included, usually the previous release tag |
| `--to <ref>` | `HEAD` | Last ref included |
| `--cwd <path>` | current directory | Repository or package directory to read |
| `--version <v>` | `--to`, or `next` when `--to` is `HEAD` | Version in the heading, without a `v` before a digit |
| `--config <file>` | none | `.json`, `.js`, `.mjs` or `.cjs` file of plugin options |
| `--json` | off | Print the resolved options and the commits, then exit |
| `--help` | | Print the flags with their resolved defaults |

These flags set a plugin option. Its values and default are documented in
[OPTIONS.md](OPTIONS.md), and `--help` prints the resolved default.

| Flag | Option |
|---|---|
| `--preset <name>` | [`preset`](OPTIONS.md#layout) |
| `--audience <name>` | [`audience`](OPTIONS.md#audience-and-model) |
| `--effort <level>` | [`effort`](OPTIONS.md#audience-and-model) |
| `--provider <name>` | [`provider`](OPTIONS.md#audience-and-model) |
| `--model <id>` | [`model`](OPTIONS.md#audience-and-model) |
| `--region <region>` | [`region`](OPTIONS.md#audience-and-model) |
| `--max-tool-calls <n>` | [`agent.maxToolCalls`](OPTIONS.md#agent-budget) |
| `--max-details <n>` | [`limits.maxDetails`](OPTIONS.md#layout) |
| `--verbose` | [`verbose`](OPTIONS.md#debugging) |

`--max-tool-calls` and `--max-details` take a whole number. A number outside the option's
range fails the run.

## Config file

Any plugin option the flags do not cover goes in a config file. The file can be JSON, an ES
module with a default export, or a CommonJS module that sets `module.exports`. Named exports
are ignored.

```js
// audience-notes.config.mjs
export default {
  preset: 'keepachangelog'
, audience: 'operators'
, includeOmitted: true
, extraSections: ['upgrade']
, typeSections: {svc: 'added'}
, releaseOptions: {
    parserOpts: {issuePrefixes: ['#', 'gh-', 'LOG-', 'PROD-'], referenceActions: ['ref', 'fixes']}
  }
}
```

```sh
npx audience-notes --from v1.4.0 --config audience-notes.config.mjs
```

- The path resolves against the directory you run the command from, not `--cwd`.
- A flag overrides the same key in the file.
- `--max-tool-calls` and `--max-details` merge into the file's `agent` and `limits` objects
  rather than replacing them.
- `releaseOptions` stands in for semantic-release's global options. Put the release config's
  `parserOpts` and `commitOpts` there to parse commits the way a real release would.
  `releaseOptions.repositoryUrl` overrides the `origin` remote.

Every option the file can set is in [OPTIONS.md](OPTIONS.md).

## Credentials

| Provider | Needs |
|---|---|
| `anthropic` | `ANTHROPIC_API_KEY`, or the variable named by `apiKeyEnv` in the config file |
| `bedrock` | A region, AWS credentials allowed `bedrock-mantle:CreateInference`, model access, and `@anthropic-ai/bedrock-sdk` |

```sh
ANTHROPIC_API_KEY=sk-ant-... npx audience-notes --from v1.4.0

AWS_PROFILE=my-profile npx audience-notes --from v1.4.0 --provider bedrock --region us-east-1
```

The Bedrock SDK is an optional dependency, so `npx -p` does not fetch it. Name it as a
second package when running without an install:

```sh
npx -p @mezmoinc/semantic-release-audience-notes -p @anthropic-ai/bedrock-sdk \
  audience-notes --from v1.4.0 --provider bedrock --region us-east-1
```

Other environment variables the CLI honors:

| Variable | Effect |
|---|---|
| `ANTHROPIC_BASE_URL` | Sends first-party requests to a gateway; ignored under Bedrock |
| `AWS_REGION`, `AWS_DEFAULT_REGION` | Region when `--region` is not given |
| `AUDIENCE_NOTES_VERBOSE` | Same as `--verbose`; `0`, `false`, `no` and `off` leave it off |

`--json` never calls the model, so it runs without credentials.

## Output

Notes go to stdout. Progress, warnings and errors go to stderr, so a redirect captures just
the document.

A normal run writes this to stderr:

```
Reading 14 commits from v0.2.16..v0.2.17
Using bedrock in us-east-1 as anthropic.claude-opus-5-5
  Investigating 14 commits with anthropic.claude-opus-5-5 (up to 60 tool calls)
    [1/60] read_diff 0babb27
    [2/60] grep CARGO_FEATURES|cargo_features
  Agent made 7 tool calls (grep×2, read_diff×4, read_commit×1)
  Token usage: 3 turns, 18,403 in, 2,389 out, 15,387 cached, 19,100 cache write
  Wrote 7 entries from 14 commits, omitted 3 (audience: operators)
```

With the `anthropic` provider and no key, the run stops with an error that names the
variable to set.

Config that resolves but probably does not mean what was written gets a `warn:` line. These
are the warnings semantic-release would log, such as a misspelled option or a preset this
plugin does not have.

### `--verbose`

Adds one line per model turn, per tool call with its input and result size, and per
submission attempt. After the run it lists every commit that got no line of its own, and
every entry that was dropped:

```
  turn 1: stop=tool_use in=12203 out=501
    read_commit {"hash":"22c7c05"} -> 553 chars
  submission 1: 25 entries, 2 omitted, 0 unresolved, 0 unaccounted
    omitted 1000f11 Merge branch 'nightly' into main. (trivial)
    supporting e2aad6c -> Skills an agent loads now stay loaded across chat turns.
    dropped 45036ad (commits-already-claimed) -> MCP tool calls carry their server namespace.
```

| Disposition | Meaning |
|---|---|
| `omitted` | The agent left the commit out, with a reason |
| `supporting` | The commit is linked from another entry and has no line of its own |
| `dropped` | An entry the agent wrote was removed, and its words are lost |

A `dropped` line is worth reading. `commits-already-claimed` means the agent described one
commit twice and the second description went away.

### `--json`

Prints one JSON object and exits without calling the model:

```json
{
  "release": {
    "from": "v1.4.0", "to": "HEAD", "gitHead": "...", "version": "next", "lastVersion": "1.4.0",
    "directory": ".", "repositoryUrl": "...", "pkgName": "..."
  },
  "options": {"preset": "conventional", "audience": {"name": "operators"}, "apiKey": "[redacted]"},
  "commits": [
    {"hash": "...", "message": "...", "subject": "...", "author": {"name": "..."}, "committerDate": "..."}
  ]
}
```

`release` is what the CLI worked out from the flags and the repository. `options` is the fully
resolved configuration, defaults included, with `typeSections` as an object and patterns
as strings such as `"/^wip/i"`. `commits` is what git returned, before parsing, ignore
rules, or revert filtering. Without a key, `--json` warns that a run would fail.

```sh
npx audience-notes --from v1.4.0 --json | jq '.commits | length'
npx audience-notes --from v1.4.0 --json | jq '.options.sections | map(.title)'
```

## Exit codes

| Code | When |
|---|---|
| `0` | Notes printed, `--json` printed, `--help`, or the reader closed the pipe early |
| `1` | A bad flag or ref, an empty range, an invalid config, or a failed run |

On failure the CLI prints the error and how to fix it to stderr. `--verbose` adds the stack
trace.

## Cost

Each run makes several model requests. The `Token usage` line on stderr reports what a run
used. [Cost](../README.md#cost) in the README lists measured runs, and
[Effort](../README.md#effort) explains when to raise or lower `--effort`.

## Recipes

Render the next release from the latest tag. In a repository with no tags yet, the empty
`--from` renders a first release:

```sh
npx audience-notes --from "$(git describe --tags --abbrev=0 2>/dev/null)"
```

Render one package of a monorepo:

```sh
npx audience-notes --cwd packages/api --from api-v2.3.0
```

Re-render a past release with its own version in the heading:

```sh
npx audience-notes --from v1.4.0 --to v1.5.0
```

Read another checkout without changing directory:

```sh
npx audience-notes --cwd ../service --from v2.3.0 --audience operators
```

Compare two audiences on the same range:

```sh
npx audience-notes --from v1.4.0 --audience developers > developers.md
npx audience-notes --from v1.4.0 --audience support > support.md
```

Check what a cheaper run loses:

```sh
npx audience-notes --from v1.4.0 --effort low > low.md
npx audience-notes --from v1.4.0 --effort high > high.md
```

## Differences from a real release

- `verifyConditions` does not run, but the CLI prints the same config warnings. A bad config
  fails before any request instead.
- The heading's compare link points at `--to`, so unreleased work links to
  `compare/<from>...HEAD`.
- semantic-release picks the range and version itself. Here `--from`, `--to` and `--version`
  set them, so the CLI can cover any range, including one no release would produce.
- From a subdirectory the CLI reads only the commits that touched it. semantic-release reads
  every commit in the branch unless a monorepo plugin filters them.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `No commits in a..b` | The range is empty or reversed, or no commit in it touched `--cwd` | Check it with `git log a..b --oneline -- .` in `--cwd` |
| `--to "…" names no commit` | A ref does not exist in `--cwd` | Fetch tags, or check the spelling |
| `is not inside a git repository` | `--cwd` is not in a checkout | Point `--cwd` at the repository or a directory in it |
| `No API key found in the ANTHROPIC_API_KEY environment variable` | No key for the `anthropic` provider | Export the key, or use `--provider bedrock` |
| `The bedrock provider needs a region` | Bedrock with no region | Pass `--region` or set `AWS_REGION` |
| `needs the @anthropic-ai/bedrock-sdk package` | The Bedrock SDK is not installed | Install it, or add `-p @anthropic-ai/bedrock-sdk` to `npx` |
| A 403 naming `bedrock-mantle:CreateInference` | The AWS identity lacks Mantle's inference permission | Grant it, or attach `AmazonBedrockMantleInferenceAccess` |
| A 403 that names no IAM action | The AWS account has no access to the model | Submit the use case form in the Bedrock console's model catalog |
| A 400 that names the model | Mantle does not serve that id, such as a `us.anthropic.…` profile | Use an `anthropic.` id, or a bare one the plugin prefixes |
| ``warn: `preset` is "…", which this plugin does not have`` | `--preset` names no preset, so the notes use `conventional` | Use `conventional` or `keepachangelog` |
| No links in the notes | The repository has no `origin` remote | Add one, or set `releaseOptions.repositoryUrl` |
| Issue keys are not linked or parsed | The parser does not know your prefixes | Pass the release config's `parserOpts` through `releaseOptions` |
| `npx` offers to install `audience-notes` | The package is not installed locally | Use `npx -p @mezmoinc/semantic-release-audience-notes audience-notes` |
