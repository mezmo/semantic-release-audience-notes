import {AudienceNotesError} from './error.js'
import {isGitRepository} from './git.js'
import {assertApiKey, misspelledOptions, normalize, presetWarning} from './options.js'

// Runs during semantic-release's verify step so a misconfiguration fails the
// run up front rather than after the build has already published.
async function verifyConditions(pluginConfig, context) {
  const options = normalize(pluginConfig, context)
  assertApiKey(options)

  const cwd = context.cwd || process.cwd()
  if (!(await isGitRepository(cwd))) {
    throw new AudienceNotesError(
      'ENOGITREPO'
    , 'This plugin reads commits with git, but no git repository was found.'
    )
  }

  if (context.logger) {
    for (const warning of configWarnings(pluginConfig, context, options)) {
      context.logger.warn(warning)
    }
  }
  return options
}

// Config that resolves but probably does not mean what was written. The CLI prints
// the same list.
function configWarnings(pluginConfig, context, options) {
  return [
    presetWarning(options)
  , ignoredWarning(pluginConfig, context)
  , ...misspelledOptions(pluginConfig).map(({key, suggestion}) => {
      return `\`${key}\` is not an option. Did you mean \`${suggestion}\`?`
    })
  ].filter(Boolean)
}

// release-notes-generator options that shape its template engine. This plugin
// renders without one, so they would otherwise be ignored silently.
const TEMPLATE_OPTIONS = ['writerOpts', 'config', 'presetConfig']

// semantic-release merges its global options into every plugin's config, so an
// option that matches the global one was set for every plugin, not for this one.
// A shared release config sets `writerOpts` globally, and warning on every run of
// every repository that extends it would say nothing actionable.
function ignoredWarning(pluginConfig, context) {
  const globals = context.options || {}
  const given = TEMPLATE_OPTIONS.filter((key) => {
    return pluginConfig && pluginConfig[key] !== undefined
      && pluginConfig[key] !== globals[key]
  })
  if (!given.length) return ''
  return `Ignoring ${given.map((key) => { return `\`${key}\`` }).join(', ')}. These configure`
    + ' release-notes-generator\'s templates, and this plugin renders without them.'
}

export {
  configWarnings
, verifyConditions
}
