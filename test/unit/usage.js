import {test} from 'tap'

import {createUsage, format} from '../../lib/usage.js'

test('createUsage() accumulates across turns', async (t) => {
  const usage = createUsage()

  usage.add({usage: {input_tokens: 12000, output_tokens: 800}})
  usage.add({usage: {input_tokens: 500, output_tokens: 1200}})

  t.same(usage.totals, {
    turns: 2
  , inputTokens: 12500
  , outputTokens: 2000
  , cacheReadTokens: 0
  , cacheWriteTokens: 0
  })
})

test('createUsage() tracks cache reads and writes separately', async (t) => {
  const usage = createUsage()

  usage.add({usage: {
    input_tokens: 500
  , output_tokens: 100
  , cache_creation_input_tokens: 11500
  }})
  usage.add({usage: {
    input_tokens: 20
  , output_tokens: 300
  , cache_read_input_tokens: 11500
  }})

  t.equal(usage.totals.cacheWriteTokens, 11500)
  t.equal(usage.totals.cacheReadTokens, 11500)
  t.match(usage.format(), /11,500 cached/)
  t.match(usage.format(), /11,500 cache write/)
})

test('createUsage() ignores a message that carries no usage', async (t) => {
  const usage = createUsage()

  usage.add({})
  usage.add(null)
  usage.add({usage: {input_tokens: 10, output_tokens: 2}})

  t.equal(usage.totals.turns, 1, 'only turns with usage are counted')
})

test('createUsage() tolerates a partial usage object', async (t) => {
  const usage = createUsage()
  usage.add({usage: {output_tokens: 2}})

  t.equal(usage.totals.inputTokens, 0, 'a missing count reads as zero, not NaN')
  t.equal(usage.totals.outputTokens, 2)

  usage.add({usage: {input_tokens: 10}})
  t.equal(usage.totals.inputTokens, 10)
})

test('format() omits cache figures when there are none', async (t) => {
  const line = format({
    turns: 3
  , inputTokens: 1000
  , outputTokens: 200
  , cacheReadTokens: 0
  , cacheWriteTokens: 0
  })

  t.equal(line, '3 turns, 1,000 in, 200 out')
  t.notMatch(line, /cache/)
})

test('format() singularizes a one-turn run', async (t) => {
  const line = format({
    turns: 1
  , inputTokens: 10
  , outputTokens: 2
  , cacheReadTokens: 0
  , cacheWriteTokens: 0
  })
  t.match(line, /^1 turn,/)
})
