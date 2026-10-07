import {execFile} from 'node:child_process'
import {TextDecoder, promisify} from 'node:util'

const run = promisify(execFile)

const MAX_BUFFER = 64 * 1024 * 1024

// Excludes are applied by git itself, so rename notation in the numstat path
// column never has to round-trip back as a pathspec.
//
// `glob` magic is required for gitignore-style semantics. Without it a leading
// `**/` demands a literal slash, so `**/package-lock.json` silently fails to
// match a root-level file.
function excludePathspecs(patterns) {
  return (patterns || []).map((pattern) => {
    return `:(glob,exclude)${pattern}`
  })
}

function parseNumstat(stdout) {
  const files = []

  for (const line of String(stdout).split('\n')) {
    if (!line.trim()) continue
    const parts = line.split('\t')
    if (parts.length < 3) continue

    const added = parts[0]
    const deleted = parts[1]
    files.push({
      path: parts.slice(2).join('\t')
    , additions: added === '-' ? 0 : Number(added) || 0
    , deletions: deleted === '-' ? 0 : Number(deleted) || 0
    , binary: added === '-' && deleted === '-'
    })
  }

  return files
}

function truncate(text, maxBytes) {
  const source = String(text)
  const buffer = Buffer.from(source, 'utf8')
  if (maxBytes <= 0) return {text: '', truncated: buffer.length > 0}
  if (buffer.length <= maxBytes) return {text: source, truncated: false}

  // Decoded with `stream: true` so a cut landing inside a multi-byte sequence
  // drops the partial character rather than emitting a replacement one. The
  // newline trim below hides that only when the tail happens to contain one.
  const decoder = new TextDecoder('utf8')
  const sliced = decoder.decode(buffer.subarray(0, maxBytes), {stream: true})
  const lastNewline = sliced.lastIndexOf('\n')
  return {
    text: lastNewline > 0 ? sliced.slice(0, lastNewline + 1) : sliced
  , truncated: true
  }
}

async function isGitRepository(cwd) {
  try {
    await run('git', ['rev-parse', '--git-dir'], {cwd, maxBuffer: MAX_BUFFER})
    return true
  } catch {
    return false
  }
}

export {
  MAX_BUFFER
, run
, parseNumstat
, excludePathspecs
, truncate
, isGitRepository
}
