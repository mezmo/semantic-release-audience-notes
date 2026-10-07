import {defineConfig} from 'eslint/config'
import logdna from 'eslint-config-logdna'

export default defineConfig([
  {
    // A config object with only `ignores` sets them globally.
    ignores: ['.tap/**']
  }
, {
    'extends': [logdna]
  , 'files': [
      'lib/**/*.js'
    , 'test/**/*.js'
    , 'bin/**/*.js'
    , '*.js'
    ]
  , 'languageOptions': {
      ecmaVersion: 2024
    , sourceType: 'module'
    }
  }
, {
    // The plugin reads the environment semantic-release hands it. Tests and the
    // CLI start child processes, so they pass on the real one.
    files: ['test/**/*.js', 'bin/**/*.js']
  , rules: {'n/no-process-env': 'off'}
  }
])
