// Accumulates token usage across the turns of one agent run.
//
// Cache counts are sub-counts of what was sent rather than extra tokens. A cache
// read is input billed at the cached rate. They are reported separately so
// a run with caching off is visibly different from one where it is on but not
// hitting. Deliberately no cost estimate -- per-token rates differ between the
// first-party API and Bedrock, so a number here would be wrong somewhere.
function createUsage() {
  const totals = {
    turns: 0
  , inputTokens: 0
  , outputTokens: 0
  , cacheReadTokens: 0
  , cacheWriteTokens: 0
  }

  return {
    totals

  , add(message) {
      const usage = message && message.usage
      if (!usage) return totals

      totals.turns++
      totals.inputTokens += usage.input_tokens || 0
      totals.outputTokens += usage.output_tokens || 0
      totals.cacheReadTokens += usage.cache_read_input_tokens || 0
      totals.cacheWriteTokens += usage.cache_creation_input_tokens || 0
      return totals
    }

  , format() {
      return format(totals)
    }
  }
}

function format(totals) {
  const parts = [
    `${totals.turns} turn${totals.turns === 1 ? '' : 's'}`
  , `${count(totals.inputTokens)} in`
  , `${count(totals.outputTokens)} out`
  ]

  if (totals.cacheReadTokens) parts.push(`${count(totals.cacheReadTokens)} cached`)
  if (totals.cacheWriteTokens) parts.push(`${count(totals.cacheWriteTokens)} cache write`)

  return parts.join(', ')
}

function count(value) {
  return value.toLocaleString('en-US')
}

export {
  createUsage
, format
}
