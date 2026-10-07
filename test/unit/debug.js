import {test} from 'tap'

import {NULL_RECORDER, createRecorder, formatRecord} from '../../lib/debug.js'

test('NULL_RECORDER stands in when a session is built without one', async (t) => {
  t.doesNotThrow(() => { return NULL_RECORDER.record('tool', {name: 'grep'}) })
})

test('createRecorder() forwards every record to its sink', async (t) => {
  const seen = []
  const recorder = createRecorder((type) => { seen.push(type) })

  recorder.record('turn', {index: 1})
  recorder.record('tool', {name: 'grep'})
  t.same(seen, ['turn', 'tool'])
})

test('createRecorder() costs nothing when nothing is listening', async (t) => {
  const recorder = createRecorder(null)

  t.equal(recorder, NULL_RECORDER, 'the no-op is shared rather than rebuilt')
})

test('formatRecord() renders one line per record', async (t) => {
  t.equal(formatRecord('system', {prompt: 'x'.repeat(4200)}), 'system: 4200 chars')
  t.equal(formatRecord('kickoff', {prompt: 'x'.repeat(90)}), 'kickoff: 90 chars')
  t.equal(
    formatRecord('turn', {index: 3, stop_reason: 'tool_use', usage: {
      input_tokens: 25013, output_tokens: 12019
    }})
  , 'turn 3: stop=tool_use in=25013 out=12019'
  )
  t.equal(
    formatRecord('turn', {index: 4, stop_reason: 'end_turn', text: 'Here are the notes.'})
  , 'turn 4: stop=end_turn in=0 out=0 said="Here are the notes."'
  , 'a turn that ends without submitting has its reason here and nowhere else'
  )
  t.equal(
    formatRecord('tool', {name: 'grep', input: {pattern: 'a|b', glob: ''}, result: 'xyz'})
  , '  grep {"pattern":"a|b","glob":""} -> 3 chars'
  , 'the whole input, which is where a malformed argument shows up'
  )
  t.equal(
    formatRecord('submission', {
      attempt: 1, entries: 0, omitted: 2, unresolved: [], unaccounted: ['a', 'b']
    })
  , 'submission 1: 0 entries, 2 omitted, 0 unresolved, 2 unaccounted'
  )
  t.match(formatRecord('run', {commits: 14}), /^run: \{"commits":14\}$/)
})

test('formatRecord() tolerates a turn the server reported no usage for', async (t) => {
  t.equal(
    formatRecord('turn', {index: 1, stop_reason: 'pause_turn'})
  , 'turn 1: stop=pause_turn in=0 out=0'
  )
})

test('formatRecord() clips a large tool input and names a failure', async (t) => {
  // submit_release_notes carries the whole release, which put kilobytes on one
  // line of the semantic-release log.
  const big = formatRecord('tool', {
    name: 'submit_release_notes'
  , input: {entries: Array.from({length: 40}, () => {
      return {headline: 'x'.repeat(40)}
    })}
  , result: 'ok'
  })

  t.ok(big.length < 260, `one line, not kilobytes (${big.length} chars)`)
  t.match(big, /…/, 'and says it was clipped')

  t.equal(
    formatRecord('tool', {name: 'read_diff', input: {}, error: 'git exploded'})
  , '  read_diff {} -> failed: git exploded'
  )
})
