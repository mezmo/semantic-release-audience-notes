import {test} from 'tap'

import {excludePathspecs, parseNumstat, truncate} from '../../lib/git.js'

test('parseNumstat() reads counts and flags binary files', async (t) => {
  const stdout = [
    '10\t2\tlib/a.js'
  , '0\t7\tlib/b.js'
  , '-\t-\timg/logo.png'
  , ''
  ].join('\n')

  t.same(parseNumstat(stdout), [
    {path: 'lib/a.js', additions: 10, deletions: 2, binary: false}
  , {path: 'lib/b.js', additions: 0, deletions: 7, binary: false}
  , {path: 'img/logo.png', additions: 0, deletions: 0, binary: true}
  ])
})

test('parseNumstat() keeps rename notation intact', async (t) => {
  const [file] = parseNumstat('3\t1\tlib/{old => new}/a.js')
  t.equal(file.path, 'lib/{old => new}/a.js')
})

test('parseNumstat() ignores blank and malformed lines', async (t) => {
  t.same(parseNumstat('\n\nnot a numstat line\n'), [])
})

test('excludePathspecs() builds git exclude magic', async (t) => {
  // `glob` magic is load-bearing: plain `:(exclude)**/x` misses root-level files.
  t.same(
    excludePathspecs(['**/dist/**', '*.map'])
  , [':(glob,exclude)**/dist/**', ':(glob,exclude)*.map']
  )
  t.same(excludePathspecs(), [], 'missing patterns are tolerated')
})

test('truncate() cuts on a line boundary and reports truncation', async (t) => {
  t.same(truncate('aaa\nbbb\nccc\n', 5), {text: 'aaa\n', truncated: true})
  t.same(truncate('aaa\n', 100), {text: 'aaa\n', truncated: false})
  t.same(truncate('aaa', 0), {text: '', truncated: true})
  t.same(truncate('', 0), {text: '', truncated: false})
})

test('truncate() measures bytes, not characters', async (t) => {
  const text = 'éééé'
  t.equal(Buffer.byteLength(text, 'utf8'), 8)
  t.ok(truncate(text, 4).truncated, 'a 4 character string over 4 bytes is truncated')
})
