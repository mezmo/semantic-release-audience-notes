// A run is otherwise a black box. Progress lines and totals say nothing about what
// the agent actually sent or got back. When a submission comes back empty or a
// tool argument arrives malformed, the fact that names the cause exists for one
// moment and is then discarded.
const NULL_RECORDER = {record() {}}

function createRecorder(onRecord) {
  if (!onRecord) return NULL_RECORDER
  return {record: onRecord}
}

// One line per record. The prompts are the exception -- they run to thousands of
// words, so their size is reported rather than their text.
function clip(text, limit) {
  return text.length > limit ? `${text.slice(0, limit)}…` : text
}

function formatRecord(type, data) {
  if (type === 'system' || type === 'kickoff') {
    return `${type}: ${data.prompt.length} chars`
  }

  if (type === 'turn') {
    const usage = data.usage || {}
    const said = data.text ? ` said="${data.text.slice(0, 120)}"` : ''
    return `turn ${data.index}: stop=${data.stop_reason}`
      + ` in=${usage.input_tokens || 0} out=${usage.output_tokens || 0}${said}`
  }

  if (type === 'tool') {
    const input = clip(JSON.stringify(data.input), 160)
    const outcome = data.error
      ? `failed: ${data.error}`
      : `${String(data.result).length} chars`
    return `  ${data.name} ${input} -> ${outcome}`
  }

  if (type === 'submission') {
    return `submission ${data.attempt}: ${data.entries} entries,`
      + ` ${data.omitted} omitted, ${data.unresolved.length} unresolved,`
      + ` ${data.unaccounted.length} unaccounted`
  }

  return `${type}: ${JSON.stringify(data)}`
}

export {
  NULL_RECORDER
, createRecorder
, formatRecord
}
