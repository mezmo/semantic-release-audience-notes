#!/usr/bin/env node
import {readFile, stat} from 'node:fs/promises'
import {pathToFileURL} from 'node:url'
import path from 'node:path'

import {generateNotes} from '../index.js'
import {
  DEFAULT_PRESET
, EFFORT_LEVELS
, PRESETS
, PRESET_ALIASES
, PROVIDERS
} from '../lib/constants.js'
import {MAX_BUFFER, isGitRepository, run} from '../lib/git.js'
import {nearest, normalize} from '../lib/options.js'
import {configWarnings} from '../lib/verify-conditions.js'

// ASCII unit and record separators. Git prints a commit message verbatim, so a
// message holding either one would split in the wrong place, but ordinary text
// never does.
const FIELD = '\x1f'
const RECORD = '\x1e'

const VALUE_FLAGS = [
  'from', 'to', 'cwd', 'version', 'config', 'preset', 'audience', 'effort', 'provider'
, 'model', 'region', 'max-tool-calls', 'max-details'
]
const SWITCHES = ['verbose', 'json', 'help']

// A `v` before a digit marks a version tag. Any other leading `v` is part of the
// ref's name, as in `vendor-sync`.
const VERSION_TAG = /^v(?=\d)/

// A mistake in the invocation itself, so the message points at --help.
class UsageError extends Error {}

// A failure the user can fix, with the fix as `details`.
class CliError extends Error {
  constructor(message, details) {
    super(message)
    this.details = details
  }
}

// Built from the plugin's own defaults so the help can never drift from what
// the code actually does.
function usage() {
  const d = normalize({}, {env: {}})
  const presets = [...PRESETS.keys()].join(' | ')

  return [
    'Render the release notes this plugin would write, without running a release.'
  , ''
  , '  npx audience-notes --cwd <repo> --from <ref> [--to <ref>] [options]'
  , ''
  , 'Options'
  , row('--from <ref>', 'Previous release, excluded', 'none, so every commit')
  , row('--to <ref>', 'Last ref included', 'HEAD')
  , row('--cwd <path>', 'Repository or package directory to read', 'current directory')
  , row('--version <v>', 'Version for the heading', '--to')
  , row('--config <file>', 'JS or JSON file exporting plugin options')
  , row('--preset <name>', presets, DEFAULT_PRESET)
  , row('--audience <name>', 'Preset name or free text', d.audience.name)
  , row('--effort <level>', EFFORT_LEVELS.join(' | '), d.effort)
  , row('--provider <name>', PROVIDERS.join(' | '), d.provider)
  , row('--model <id>', 'Bedrock prefixes this itself', d.model)
  , row('--region <region>', 'AWS region, required for bedrock', '$AWS_REGION')
  , row('--max-tool-calls <n>', 'Cap exploration; follows --effort', d.agent.maxToolCalls)
  , row('--max-details <n>', 'Prose details; follows --effort', d.limits.maxDetails)
  , row('--verbose', 'Log every turn, tool call and submission attempt')
  , row('--json', 'Print the resolved config and commits, then exit')
  , row('--help', 'Show this message')
  , ''
  , 'A flag overrides the same key in --config. Notes go to stdout and progress to'
  , 'stderr, so `> NOTES.md` captures just the document.'
  ].join('\n')
}

function row(flag, description, fallback) {
  const suffix = fallback === undefined ? '' : ` (default: ${fallback})`
  return `  ${flag.padEnd(22)}${description}${suffix}`
}

// Takes `--flag value` and `--flag=value`. Anything it does not recognize fails,
// because a dropped flag still runs, and pays for, the model call.
function parseArgs(argv) {
  const args = {}
  for (let index = 0; index < argv.length; index++) {
    const token = argv[index]
    if (!token.startsWith('--')) {
      throw new UsageError(`Unexpected argument "${token}". Every flag starts with --.`)
    }

    const equals = token.indexOf('=')
    const name = token.slice(2, equals === -1 ? undefined : equals)
    const inline = equals === -1 ? undefined : token.slice(equals + 1)

    if (SWITCHES.includes(name)) {
      if (inline !== undefined) throw new UsageError(`--${name} takes no value.`)
      args[name] = true
      continue
    }
    if (!VALUE_FLAGS.includes(name)) {
      const near = nearest(name, [...VALUE_FLAGS, ...SWITCHES])
      throw new UsageError(`Unknown flag --${name}.${near ? ` Did you mean --${near}?` : ''}`)
    }

    const value = inline === undefined ? argv[++index] : inline
    if (value === undefined || (inline === undefined && value.startsWith('--'))) {
      throw new UsageError(`--${name} needs a value.`)
    }
    // An empty --from is how `--from "$(git describe ...)"` reads in a repository
    // with no tags yet, and it means the same as leaving --from out.
    if (!value && name !== 'from') throw new UsageError(`--${name} needs a value.`)
    args[name] = value
  }
  return args
}

function count(args, name) {
  if (args[name] === undefined) return undefined
  if (!/^\d+$/.test(args[name])) throw new UsageError(`--${name} needs a whole number.`)
  return Number(args[name])
}

// Resolves the directory to read and how far it sits below the repository root.
async function locate(dir) {
  const info = await stat(dir).catch(() => { return null })
  if (!info || !info.isDirectory()) throw new CliError(`${dir} is not a directory.`)
  if (!await isGitRepository(dir)) {
    throw new CliError(`${dir} is not inside a git repository.`)
  }
  const {stdout} = await run('git', ['rev-parse', '--show-prefix'], {cwd: dir})
  return stdout.trim().replace(/\/$/, '')
}

// A SHA, so the tools read one tree for the whole run even if the branch moves.
// semantic-release passes one the same way.
async function resolveRef(cwd, ref, flag) {
  try {
    const {stdout} = await run('git', ['rev-parse', '--verify', `${ref}^{commit}`], {cwd})
    return stdout.trim()
  } catch {
    throw new CliError(
      `${flag} "${ref}" names no commit in ${cwd}.`
    , 'Fetch tags with `git fetch --tags`, or check the spelling.'
    )
  }
}

// Mirrors the commit shape semantic-release hands to generateNotes. From a
// subdirectory it lists only the commits that touched it, because the agent's
// tools see nothing outside it.
async function readCommits(cwd, range, scoped) {
  const format = ['%H', '%an', '%cI', '%B'].join(FIELD) + RECORD
  const {stdout} = await run(
    'git'
  , [
      'log', '--no-show-signature', `--format=${format}`, range
    , ...(scoped ? ['--', '.'] : [])
    ]
  , {cwd, maxBuffer: MAX_BUFFER}
  )

  return stdout
    .split(RECORD)
    .map((record) => {
      return record.trim()
    })
    .filter(Boolean)
    .map((record) => {
      const [hash, author, date, message] = record.split(FIELD)
      return {
        hash
      , message: message.trim()
      , subject: message.trim().split('\n')[0]
      , author: {name: author}
      , committerDate: date
      }
    })
}

async function remoteUrl(cwd) {
  try {
    const {stdout} = await run('git', ['remote', 'get-url', 'origin'], {cwd})
    return stdout.trim()
  } catch {
    return ''
  }
}

async function packageName(cwd) {
  try {
    return JSON.parse(await readFile(path.join(cwd, 'package.json'), 'utf8')).name || ''
  } catch {
    return ''
  }
}

// Importing JSON needs an import attribute, so it is read directly. A module
// supplies its default export, which for CommonJS is `module.exports`, and a
// module with only named exports supplies nothing.
async function readConfig(file) {
  const target = path.resolve(file)
  const config = target.endsWith('.json')
    ? JSON.parse(await readFile(target, 'utf8'))
    : (await import(pathToFileURL(target).href)).default || {}

  if (!isObject(config)) {
    throw new CliError(`${file} must hold an object of plugin options.`)
  }
  if (config.releaseOptions !== undefined && !isObject(config.releaseOptions)) {
    throw new CliError(`\`releaseOptions\` in ${file} must be an object.`)
  }
  return config
}

function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

// The resolved options carry whatever the key env var held.
function redact(options) {
  return {...options, apiKey: options.apiKey ? '[redacted]' : ''}
}

// The canonical name of the preset that renders, which the options do not carry.
function presetName(pluginConfig, resolved) {
  if (resolved.presetFallback || !pluginConfig.preset) return DEFAULT_PRESET
  return PRESET_ALIASES.get(pluginConfig.preset) || pluginConfig.preset
}

// JSON.stringify writes a Map or a RegExp as `{}`.
function readable(key, value) {
  if (value instanceof Map) return Object.fromEntries(value)
  if (value instanceof RegExp) return String(value)
  return value
}

let verbose = false

async function main() {
  const args = parseArgs(process.argv.slice(2))
  verbose = Boolean(args.verbose)
  if (args.help) {
    process.stdout.write(`${usage()}\n`)
    return
  }

  const cwd = path.resolve(args.cwd || process.cwd())
  const from = args.from || ''
  const to = args.to || 'HEAD'
  const version = (args.version || (to === 'HEAD' ? 'next' : to)).replace(VERSION_TAG, '')
  const maxToolCalls = count(args, 'max-tool-calls')
  const maxDetails = count(args, 'max-details')

  const fileConfig = args.config ? await readConfig(args.config) : {}
  const releaseOptions = fileConfig.releaseOptions || {}

  const pluginConfig = {
    ...fileConfig
  , ...(args.audience ? {audience: args.audience} : {})
  , ...(args.preset ? {preset: args.preset} : {})
  , ...(args.effort ? {effort: args.effort} : {})
  , ...(args.provider ? {provider: args.provider} : {})
  , ...(args.model ? {model: args.model} : {})
  , ...(args.region ? {region: args.region} : {})
  , ...(maxToolCalls === undefined
      ? {}
      : {agent: {...fileConfig.agent, maxToolCalls}})
  , ...(maxDetails === undefined ? {} : {limits: {...fileConfig.limits, maxDetails}})
  , ...(args.verbose ? {verbose: true} : {})
  }

  const prefix = await locate(cwd)
  const [fromHead, toHead] = await Promise.all([
    from ? resolveRef(cwd, from, '--from') : ''
  , resolveRef(cwd, to, '--to')
  ])
  const range = from ? `${fromHead}..${toHead}` : toHead
  const shown = `${from ? `${from}..` : 'every commit up to '}${to}${prefix ? ` in ${prefix}` : ''}`

  const [commits, repositoryUrl, pkgName] = await Promise.all([
    readCommits(cwd, range, Boolean(prefix))
  , releaseOptions.repositoryUrl ? '' : remoteUrl(cwd)
  , packageName(cwd)
  ])
  if (!commits.length) throw new CliError(`No commits in ${shown}.`)

  // npm sets the package name for the directory npx ran in, which is not --cwd.
  const env = {...process.env}
  delete env.npm_package_name

  const lastRelease = from
    ? {version: from.replace(VERSION_TAG, ''), gitTag: from, gitHead: fromHead}
    : {}
  const context = {
    cwd
  , env
  , commits
  , lastRelease
  , nextRelease: {version, gitTag: to, gitHead: toHead}
  , options: {repositoryUrl, pkgName, ...releaseOptions}
  , logger: {
      log: (message) => { process.stderr.write(`  ${message}\n`) }
    , warn: (message) => { process.stderr.write(`  warn: ${message}\n`) }
    , error: (message) => { process.stderr.write(`  error: ${message}\n`) }
    }
  }

  process.stderr.write(`Reading ${commits.length} commits from ${shown}\n`)

  // The plugin resolves the config itself, so bad config fails here rather than
  // after the first request.
  const resolved = normalize(pluginConfig, context)
  verbose = resolved.verbose
  for (const warning of configWarnings(pluginConfig, context, resolved)) {
    process.stderr.write(`warn: ${warning}\n`)
  }
  if (resolved.provider === 'bedrock') {
    process.stderr.write(`Using bedrock in ${resolved.region} as ${resolved.model}\n`)
  }

  if (args.json) {
    if (resolved.provider !== 'bedrock' && !resolved.apiKey) {
      process.stderr.write(`warn: ${resolved.apiKeyEnv} is not set, so a run would fail.\n`)
    }
    const report = {
      release: {
        from: from || null
      , to
      , gitHead: toHead
      , version
      , lastVersion: lastRelease.version || null
      , directory: prefix || '.'
      , repositoryUrl: context.options.repositoryUrl
      , pkgName: context.options.pkgName
      }
    , options: {preset: presetName(pluginConfig, resolved), ...redact(resolved)}
    , commits
    }
    process.stdout.write(`${JSON.stringify(report, readable, 2)}\n`)
    return
  }

  process.stdout.write(await generateNotes(pluginConfig, context))
}

function report(err) {
  if (!(err instanceof Error)) {
    process.stderr.write(`error: ${String(err)}\n`)
    return
  }
  process.stderr.write(`error: ${err.message}\n`)
  if (err.details) process.stderr.write(`${err.details}\n`)
  if (err instanceof UsageError) process.stderr.write('Run with --help for every flag.\n')
  if (verbose) process.stderr.write(`\n${err.stack}\n`)
}

// Node reports a closed pipe as an `error` event, and unhandled it crashes the
// process. A reader that stops early, such as `| head`, is a normal end.
process.stdout.on('error', (err) => {
  if (err.code !== 'EPIPE') report(err)
  process.exit(err.code === 'EPIPE' ? 0 : 1)
})

main().catch((err) => {
  report(err)
  process.exit(1)
})
