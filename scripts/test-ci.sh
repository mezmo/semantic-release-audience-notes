#!/bin/bash

# Rebuild tap's bundled Test class so the `!@tapjs/typescript` plugin
# exclusion in package.json is applied. A fresh install ships a default
# build that includes the TypeScript plugin, whose ts-node loader crashes
# against TypeScript 7.x. All tests here are plain JS, so the plugin is
# unwanted; without this step it loads and fails on a clean checkout.
npm run tap -- build

npm run tap -- -R tap

code=$?
npm run tap replay -- -R junit --reporter-file .tap/test.xml
exit $code
