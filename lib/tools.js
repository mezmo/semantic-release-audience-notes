import path from 'node:path'

import {betaTool} from '@anthropic-ai/sdk/helpers/beta/json-schema'

import {minimatch} from 'minimatch'
import {resolveHash} from './commits.js'
import {audit, resolve} from './submission.js'
import {NULL_RECORDER} from './debug.js'
import {MAX_BUFFER, excludePathspecs, parseNumstat, run, truncate} from './git.js'
import {build as buildSubmitSchema} from './schema.js'

// Mirrors git grep's --max-count, so a file at the cap is reported as "n+".
const GREP_MAX_COUNT = 50

// Every tool is read-only and scoped to one repository at one ref. Results are
// byte-capped individually so a single call can never blow the context window,
// and the shared call counter bounds the whole run.
function createTools(session) {
  return [
    readCommit(session)
  , readDiff(session)
  , readFile(session)
  , grep(session)
  , submitReleaseNotes(session)
  ].map((tool) => {
    return recorded(tool, session)
  })
}

// The progress line carries a tool's name and a scrap of its input. That was
// enough to notice a malformed argument and not enough to see what it was, so the
// transcript takes the whole call, both what the agent asked for and what it got.
function recorded(tool, session) {
  const inner = tool.run.bind(tool)

  tool.run = async (input) => {
    try {
      const result = await inner(input)
      session.recorder.record('tool', {name: tool.name, input, result})
      return result
    } catch (err) {
      session.recorder.record('tool', {name: tool.name, input, error: err.message})
      throw err
    }
  }

  return tool
}

function createSession(payload, options, context) {
  return {
    cwd: (context && context.cwd) || process.cwd()
  , ref: (context && context.nextRelease && context.nextRelease.gitHead) || 'HEAD'
  , options
  , commits: new Map(payload.map((commit) => {
      return [commit.hash, commit]
    }))
  , payload
  , calls: 0
  , retries: 0
  , best: null
  , submission: null
  , log: []
  , listingTruncated: Boolean(context && context.listingTruncated)
  , recorder: (context && context.recorder) || NULL_RECORDER
  , onCall: (context && context.onCall) || (() => {})
  , onProblem: (context && context.onProblem) || (() => {})
  }
}

// Returns the exhaustion message once the budget is spent, and null while it
// remains. Callers return that message to the model so it wraps up rather than
// failing the turn.
function spend(session, name, detail) {
  session.calls++
  session.log.push(name)
  session.onCall({name, detail, index: session.calls})
  if (session.calls > session.options.agent.maxToolCalls) {
    return `Tool-call budget of ${session.options.agent.maxToolCalls} is exhausted. `
      + 'Call submit_release_notes now with what you already know.'
  }
  return null
}

function resolveCommit(session, hash) {
  return session.commits.get(resolveHash(hash, session.commits)) || null
}

function readCommit(session) {
  return betaTool({
    name: 'read_commit'
  , description:
      'Read the per-file line counts one commit touched, to judge its size and reach '
        + 'before read_diff. '
        + (session.listingTruncated
        ? 'The listing above omitted messages, so this returns that commit\'s too.'
        : 'The listing above already has every message, so this adds only the files.')
  , inputSchema: {
      type: 'object'
    , properties: {
        hash: {type: 'string', description: 'Short hash from the listing above.'}
      }
    , required: ['hash']
    , additionalProperties: false
    }
  , run: async ({hash}) => {
      const over = spend(session, 'read_commit', hash)
      if (over) return over

      const commit = resolveCommit(session, hash)
      if (!commit) return `No commit ${hash} in this release. Every valid hash is in the listing above.`

      const lines = [
        `commit ${commit.hash}`
      , `subject: ${commit.subject}`
      , `type: ${commit.type || '(none)'}`
      , `scope: ${commit.scope || '(none)'}`
      , `breaking: ${commit.breaking ? 'yes' : 'no'}`
      ]
      if (commit.references.length) lines.push(`references: ${commit.references.join(', ')}`)
      for (const note of commit.breakingNotes) lines.push(`breaking note: ${note}`)
      // The listing carries every message unless it overflowed, and a second copy
      // is re-sent on every turn that follows.
      if (session.listingTruncated && commit.body) lines.push(`body:\n${commit.body}`)

      const stat = await numstat(session, commit.fullHash)
      lines.push(`files changed (+${stat.additions} -${stat.deletions}):`)
      lines.push(stat.files.map((file) => {
        return file.binary
          ? `  ${file.path} (binary)`
          : `  ${file.path} +${file.additions} -${file.deletions}`
      }).join('\n') || '  (none)')

      // The one read tool with no cap. A squash-merge body runs to hundreds of
      // kilobytes, and every later turn re-sends it.
      const cut = truncate(lines.join('\n'), session.options.agent.maxToolResultBytes)
      return cut.truncated ? `${cut.text}\n... commit truncated` : cut.text
    }
  })
}

// A grep hit names a file and a line, so reading the region around it beats
// reading the file. Line numbers are added only on a ranged read, where they let
// the model line the result up against the grep output that sent it here.
function sliceLines(text, start, end) {
  if (!start && !end) return text

  const lines = String(text).split('\n')

  // A trailing newline leaves an empty final element that is not a line.
  if (lines[lines.length - 1] === '') lines.pop()

  const from = Math.min(Math.max(1, start || 1), lines.length)
  const to = Math.max(from, Math.min(lines.length, end || lines.length))
  const width = String(to).length
  const body = lines.slice(from - 1, to).map((line, index) => {
    return `${String(from + index).padStart(width)}: ${line}`
  }).join('\n')

  return `lines ${from}-${to} of ${lines.length}:\n${body}`
}

// A narrow glob keeps a result small, but the model has to guess the path to
// write one, and a wrong guess costs a whole turn. Counting per file makes the
// wide search cheap, so the narrowing happens after the evidence arrives.
function summarize(text, limitBytes) {
  const counts = new Map()
  let total = 0
  for (const line of text.split('\n')) {
    const match = /^(.*?):\d+:/.exec(line)
    if (!match) continue
    counts.set(match[1], (counts.get(match[1]) || 0) + 1)
    total++
  }

  const rows = [...counts.entries()]
    .sort((left, right) => { return right[1] - left[1] })
    .map(([file, count]) => {
      // git grep stops at GREP_MAX_COUNT per file, so a file at the cap has more.
      return `  ${file} ${count}${count >= GREP_MAX_COUNT ? '+' : ''}`
    })
    .join('\n')

  const cut = truncate(rows, limitBytes)
  const files = counts.size === 1 ? '1 file' : `${counts.size} files`
  return `${total} matches in ${files}. Lines omitted: the full result `
    + 'exceeded the size budget. Search again with a `glob` to read them.\n\n'
    + `${cut.text}${cut.truncated ? '\n... file list truncated' : ''}`
}

// Searching a rev makes git prefix every line with it, a 40-character sha in a
// release. The description promises a file and a line number, so the model reads
// the first field as a path and hands it back to read_file.
function stripRef(text, ref) {
  const prefix = `${ref}:`
  return text.split('\n').map((line) => {
    return line.startsWith(prefix) ? line.slice(prefix.length) : line
  }).join('\n')
}

function readDiff(session) {
  return betaTool({
    name: 'read_diff'
  , description:
      'Read the patch for one commit, optionally limited to a single file path. '
        + 'Expensive, so prefer read_commit first, and scope to a path when only one '
        + 'file matters.'
  , inputSchema: {
      type: 'object'
    , properties: {
        hash: {type: 'string', description: 'Short hash from the listing above.'}
      , path: {
          type: 'string'
        , description:
            'Optional file path to limit the patch to. Empty string reads all files.'
        }
      }
    , required: ['hash', 'path']
    , additionalProperties: false
    }
  , run: async ({hash, path: filePath}) => {
      const over = spend(session, 'read_diff', [hash, filePath].filter(Boolean).join(' '))
      if (over) return over

      const commit = resolveCommit(session, hash)
      if (!commit) return `No commit ${hash} in this release. Every valid hash is in the listing above.`

      const scope = filePath ? [safeRelative(session, filePath)] : []
      if (filePath && !scope[0]) return `Path ${filePath} is outside the repository.`

      // --relative, like numstat, so paths match what read_file and grep take and
      // the excludes apply from the same directory.
      const args = [
        'show', '--no-color', '--no-show-signature', '--format=', '--patch'
      , '--relative', '-M'
      , `--unified=${session.options.introspect.contextLines}`
      , commit.fullHash
      , '--'
      , ...scope
      , ...excludePathspecs(session.options.introspect.exclude)
      ]
      let stdout = ''
      try {
        ({stdout} = await run('git', args, {cwd: session.cwd, maxBuffer: MAX_BUFFER}))
      } catch {
        return 'Could not read that diff. The commit may be outside a shallow clone.'
      }

      const cut = truncate(stdout, session.options.agent.maxToolResultBytes)
      if (!cut.text) {
        return 'That commit has no readable diff (binary or fully excluded files).'
      }
      return cut.truncated ? `${cut.text}\n... patch truncated` : cut.text
    }
  })
}

function readFile(session) {
  return betaTool({
    name: 'read_file'
  , description:
      'Read a file as it exists at this release, to understand the code a diff '
        + 'changed. Use when a patch alone does not make the behavior change clear. '
        + 'Pass the line number grep reported to read just that region instead of '
        + 'the whole file.'
  , inputSchema: {
      type: 'object'
    , properties: {
        path: {
          type: 'string'
        , description:
            'File path, relative to the directory this release is cut from.'
        }
      , start: {
          type: 'integer'
        , description: 'First line to read, counting from 1. Zero starts at the top.'
        }
      , end: {
          type: 'integer'
        , description: 'Last line to read, inclusive. Zero reads to the end.'
        }
      }
    , required: ['path', 'start', 'end']
    , additionalProperties: false
    }
  , run: async ({path: filePath, start, end}) => {
      const detail = [filePath, start, end].filter(Boolean).join(' ')
      const over = spend(session, 'read_file', detail)
      if (over) return over

      const relative = safeRelative(session, filePath)
      if (!relative) return `Path ${filePath} is outside the repository.`
      if (excluded(session, relative)) {
        return `${relative} is excluded from the files this release exposes.`
      }

      try {
        const {stdout} = await run(
          'git'
        , ['show', `${session.ref}:./${relative}`]
        , {cwd: session.cwd, maxBuffer: MAX_BUFFER}
        )
        const region = sliceLines(stdout, start, end)
        const cut = truncate(region, session.options.agent.maxToolResultBytes)
        return cut.truncated ? `${cut.text}\n... file truncated` : cut.text
      } catch {
        return `No file at ${relative} in this release.`
      }
    }
  })
}

function grep(session) {
  return betaTool({
    name: 'grep'
  , description:
      'Search the repository at this release for a pattern, returning matching lines '
        + 'with their file and line number. Use to find callers or definitions related '
        + 'to a change. A search too broad to return in full comes back as a count per '
        + 'file instead, so searching wide and then narrowing with `glob` costs less '
        + 'than guessing a path.'
  , inputSchema: {
      type: 'object'
    , properties: {
        pattern: {type: 'string', description: 'Extended regular expression.'}
      , glob: {
          type: 'string'
        , description: 'Optional pathspec to limit the search, such as "lib/**". '
            + 'Empty string searches everything.'
        }
      }
    , required: ['pattern', 'glob']
    , additionalProperties: false
    }
  , run: async ({pattern, glob}) => {
      const over = spend(session, 'grep', pattern)
      if (over) return over

      const scope = [
        ...(glob ? [`:(glob)${glob}`] : [])
      , ...excludePathspecs(session.options.introspect.exclude)
      ]
      try {
        // Arguments are passed through execFile, never a shell.
        const {stdout} = await run(
          'git'
        , [
            'grep', '--no-color', '-n', '-I', '-E', `--max-count=${GREP_MAX_COUNT}`
          , '-e', pattern, session.ref, '--', ...scope
          ]
        , {cwd: session.cwd, maxBuffer: MAX_BUFFER}
        )
        // Stripped before measuring. Every line carries the 40-character ref, so
        // measuring first spends a fifth of the budget on repeated shas.
        const text = stripRef(stdout, session.ref)
        const limit = session.options.agent.maxToolResultBytes
        if (Buffer.byteLength(text) > limit) return summarize(text, limit)
        return text
      } catch (err) {
        // git grep exits 1 on a genuine miss and 128 on a bad pattern or ref.
        // Reporting both as "no matches" tells the model a symbol has no call
        // sites when the search never ran, and it treats that as evidence.
        if (err.code === 1) return 'No matches.'
        return 'That search could not run. Check the pattern is an extended regular '
          + 'expression, with no lookahead or backreference, and that the path scope '
          + 'is valid.'
      }
    }
  })
}

// The shape is not checked here. A rejected call stays in the conversation as a
// template the model copies, so asking again reproduces the same malformed
// submission rather than correcting it. See anthropics/claude-code#62344.
function submitReleaseNotes(session) {
  return betaTool({
    name: 'submit_release_notes'
  , description:
      'Submit the finished release notes. Call this exactly once, when you have read '
        + 'enough to describe the release. Every commit must appear either in an entry '
        + 'or in the omitted list.'
  , inputSchema: buildSubmitSchema(session.options)
  , run: async (input) => {
      return record(session, input)
    }
  })
}

// Coverage is judged here rather than a turn later in the agent loop, so an
// incomplete answer comes back as this call's own tool result. Asking through a
// pushed message instead costs a request that went out before the question, and
// the runner drops the turn that message interrupts along with its tool calls.
function better(resolved, missing, best) {
  if (missing !== best.missing) return missing < best.missing
  return resolved.entries.length > best.resolved.entries.length
}

// Why lib/entries.js drops an entry, worded for the agent that wrote it.
const DROP_REASONS = {
  'commits-already-claimed': 'every commit it named is already on an earlier entry'
, 'no-commits': 'it named no commit in this release'
, 'no-section': 'its section is not in the table'
, 'not-breaking': 'only breaking commits belong in that section'
, 'restates-a-breaking-entry': 'a breaking entry in that section already covers it'
}

function record(session, input) {
  const resolved = resolve(input, session.payload)
  const {missing, dropped} = audit(resolved, session.options)

  session.retries++
  session.recorder.record('submission', {
    attempt: session.retries
  , raw: input
  , entries: resolved.entries.length
  , omitted: resolved.omitted.length
  , unresolved: resolved.unresolved
  , unaccounted: missing
  })

  if (resolved.unresolved.length) {
    session.onProblem(
      `Submission named ${resolved.unresolved.length} hashes matching no commit`
        + ` in this release: ${resolved.unresolved.join(', ')}`
    )
  }

  // A retry can improve the answer but never spoil it. Fewer unaccounted commits
  // wins, and where that ties the attempt describing more of them does, so an
  // answer that reaches full coverage by omitting everything cannot displace one
  // that described the release.
  if (!session.best || better(resolved, missing.length, session.best)) {
    session.best = {resolved, missing: missing.length}
  }

  const spare = session.retries <= session.options.agent.maxSubmissionRetries
  if (!missing.length) {
    session.submission = resolved
    return 'Release notes recorded. Stop now and end your turn.'
  }

  if (!spare) {
    session.submission = session.best.resolved
    return `Recorded, with ${session.best.missing} commits still unaccounted for.`
      + ' They will be listed from their subjects. Stop now and end your turn.'
  }

  return [
    'Not recorded. These commits are in neither an entry nor omitted:'
  , missing.join(', ')
  , ...dropped.length
      ? [
        ''
      , 'These entries were dropped, so the commits they named do not count:'
      , ...dropped.map((entry) => {
          return `- "${entry.headline}" (${entry.hashes.join(', ') || 'no commits'}),`
            + ` dropped because ${DROP_REASONS[entry.reason]}.`
        })
      ]
      : []
  , ''
  , 'Every commit must appear in exactly one place. Call submit_release_notes'
  , 'again with everything you already wrote plus what is missing. Dropping'
  , 'entries you have written is worse than the attempt before it.'
  ].join('\n')
}

// `git show <ref>:<path>` takes no pathspec, so the exclude list is applied here
// rather than in the argv the way every other read tool does it. Git also treats a
// pattern that matches a directory as excluding everything under it, so a path
// under a matching directory is excluded here too.
function excluded(session, relative) {
  return session.options.introspect.exclude.some((pattern) => {
    const directory = `${pattern.replace(/\/+$/, '')}/**`
    return minimatch(relative, pattern, {dot: true})
      || minimatch(relative, directory, {dot: true})
  })
}

// Confines a model-supplied path to the repository; returns null on escape.
function safeRelative(session, filePath) {
  const root = path.resolve(session.cwd)
  const resolved = path.resolve(root, String(filePath || ''))
  const relative = path.relative(root, resolved)
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return null
  return relative.split(path.sep).join('/')
}

async function numstat(session, fullHash) {
  const args = [
    'show', '--no-color', '--no-show-signature', '--format=', '--numstat', '--relative'
  , '-M', fullHash
  , '--'
  , ...excludePathspecs(session.options.introspect.exclude)
  ]
  let stdout = ''
  try {
    ({stdout} = await run('git', args, {cwd: session.cwd, maxBuffer: MAX_BUFFER}))
  } catch {
    // The message is still worth reporting without the file list, and raw git
    // stderr carries the absolute repository path into the model's context.
    return {files: [], additions: 0, deletions: 0}
  }

  const files = parseNumstat(stdout)
  const capped = files
    .sort((a, b) => {
      return (b.additions + b.deletions) - (a.additions + a.deletions)
    })
    .slice(0, session.options.introspect.maxFilesPerCommit)

  return {
    files: capped
  , additions: files.reduce((sum, file) => {
      return sum + file.additions
    }, 0)
  , deletions: files.reduce((sum, file) => {
      return sum + file.deletions
    }, 0)
  }
}

export {
  createTools
, createSession
, safeRelative
, spend
}
