# Security Policy

## Data handling

Each run sends parts of the repository to a model provider. Every commit message in the
release goes, and so does whatever the agent reads through its tools: a commit's changed
files and line counts, its diffs, file contents at the release ref, and `grep` results. The
audience description, `extraGuidance`, the package name, and the previous and next
version numbers go too.

| Provider | Where the data goes |
|---|---|
| `anthropic` | The Anthropic API, or the gateway named by `baseUrl` |
| `bedrock` | Amazon Bedrock in your AWS account, in the region you configure |

Retention follows that provider's terms, not this plugin's.

Paths matching `introspect.exclude` never reach the model. Diffs, file lists and searches
skip them, and `read_file` refuses them. Add any path that holds secrets or data that must
not leave your network. Every tool is read-only, is scoped to the repository at the release
ref, and refuses paths outside the repository root.

The API key is read only from the environment variable named by `apiKeyEnv`, never from
the release config. The notes are written by a model and published as they come out, so
they can repeat names and values the agent read in the code.

## Untrusted input

Anyone who can get a commit merged writes part of what the model reads, so a commit
message or a file can try to steer the notes. The prompt tells the model that repository
content is material to describe, never instructions. Whatever it writes back, the plugin
keeps only the text of a markdown link or image and escapes HTML tags, so the notes
cannot carry a hidden link, a tracking image, or markup into a GitHub release or a
changelog. Commit and issue links come from the repository URL alone. A bare URL in the
text stays visible as written, so review the notes as you would any release text.

## Reporting a vulnerability

Report suspected vulnerabilities privately to
[security@mezmo.com](mailto:security@mezmo.com). Do not open a public issue for one.
Include the affected version, your release config with secrets removed, reproduction
steps, and the impact you observed. Never include live credentials or customer data.

Use a public issue only for a hardening request that discloses nothing sensitive.

## Supported versions

Security fixes target the latest release. Upgrade before reporting a problem that may
already be fixed.
