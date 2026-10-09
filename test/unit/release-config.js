import {test} from 'tap'

import config from '../../release.config.js'

// package.json makes every .js file an ES module, so this config must export with
// `export default`. A CommonJS one loads as an empty module and the release falls
// back to semantic-release's defaults.
test('release.config.js extends the shared Mezmo release config', async (t) => {
  t.equal(config.extends, '@mezmoinc/release-config-core')
  t.same(config.branches, ['main'])
  t.equal(config.npmPublish, true)
})
