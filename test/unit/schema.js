import {test} from 'tap'

import {build} from '../../lib/schema.js'
import {OMISSION_REASONS} from '../../lib/constants.js'
import {normalize} from '../../lib/options.js'

const OPTIONS = normalize({}, {env: {}})

test('build() emits a schema the tool-input validator accepts', async (t) => {
  const schema = build(OPTIONS)

  t.equal(schema.additionalProperties, false)
  t.same(schema.required, ['entries', 'omitted'])

  const entry = schema.properties.entries.items
  t.equal(entry.additionalProperties, false)
  t.same(
    Object.keys(entry.properties).sort()
  , [...entry.required].sort()
  , 'no entry property is declared without being required'
  )

  const omitted = schema.properties.omitted.items
  t.equal(omitted.additionalProperties, false)
  t.same(
    Object.keys(omitted.properties).sort()
  , [...omitted.required].sort()
  )
})

test('build() lets one entry claim several commits', async (t) => {
  const hashes = build(OPTIONS).properties.entries.items.properties.hashes
  t.equal(hashes.type, 'array', 'grouping is expressible in the contract')
  t.same(hashes.items, {type: 'string'})
})

test('build() closes the section and reason vocabularies', async (t) => {
  const schema = build(OPTIONS)
  t.same(schema.properties.entries.items.properties.section.enum, OPTIONS.sectionIds)
  t.same(schema.properties.omitted.items.properties.reason.enum, OMISSION_REASONS)
})

test('build() avoids constraints structured outputs reject', async (t) => {
  const constraint = /"(minLength|maxLength|minimum|maximum|minItems|maxItems)"/
  t.notOk(JSON.stringify(build(OPTIONS)).match(constraint))
})

test('build() asks for no summary at all', async (t) => {
  // A paragraph-length leading string parameter flips the model out of JSON tool
  // calls into its legacy XML syntax and takes the entries array with it. Removing
  // it took 16% of runs producing nothing down to 0 of 30, and a conventional
  // changelog carries no summary paragraph either.
  for (const preset of ['conventional', 'keepachangelog']) {
    const schema = build(normalize({preset}, {env: {}}))
    t.same(
      Object.keys(schema.properties)
    , ['entries', 'omitted']
    , `${preset}: no prose-valued parameter at the top level`
    )
    t.same(schema.required, ['entries', 'omitted'], `${preset}: required matches`)
  }
})

test('build() states the details limit the options set', async (t) => {
  function description(limits) {
    const options = normalize({preset: 'keepachangelog', limits}, {env: {}})
    return build(options).properties.entries.items.properties.details.description
  }

  t.match(description({maxDetails: 2}), /^Up to 2 further sentences/)
  t.match(description({maxDetails: 7}), /^Up to 7 further sentences/)
})
