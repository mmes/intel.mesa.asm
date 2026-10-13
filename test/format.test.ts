// Column alignment tests.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { alignColumns, DEFAULT_FORMAT, type FormatOptions } from '../src/format/align.ts';
import { parseDocument } from '../src/parser/parse.ts';

const CORPUS = path.join(import.meta.dirname, 'corpus');
const corpus = ['mesa', 'samples'].flatMap((dir) =>
  fs.readdirSync(path.join(CORPUS, dir)).filter((f) => /\.(txt|asm)$/.test(f)).sort().map((f) => path.join(dir, f)));
const read = (file: string) => fs.readFileSync(path.join(CORPUS, file), 'utf8').split('\n');

const PRINTER: FormatOptions = { ...DEFAULT_FORMAT, columns: 'printer' };

function format(lines: readonly string[], options?: FormatOptions, range?: { start: number; end: number }): string[] {
  const out = [...lines];
  for (const edit of alignColumns(lines, parseDocument(lines), options, range)) out[edit.line] = edit.text;
  return out;
}

const squeeze = (lines: readonly string[]) => lines.map((l) => l.replace(/\s+/g, ' ').trimEnd());

for (const file of corpus) {
  test(`${file}: printer columns reproduce Mesa's spacing exactly`, () => {
    const lines = read(file);
    assert.deepEqual(alignColumns(lines, parseDocument(lines), PRINTER), []);
  });

  test(`${file}: aligning changes whitespace only, once, and can be undone`, () => {
    const lines = read(file);
    const aligned = format(lines);
    assert.deepEqual(squeeze(aligned), squeeze(lines));
    assert.deepEqual(format(aligned), aligned);
    assert.deepEqual(format(aligned, PRINTER), lines.map((l) => l.trimEnd()));
  });
}

const column = (line: string, field: string) => line.indexOf(field);

test('a wide field widens its column for the whole shader', () => {
  const out = format([
    '        mov (16)                  r8            r0.1<0>                           {Compacted}',
    '        mov (16)                  r4            r[a0.0 + 32]<VxH;1,0>:f r6 {I@1}',
    '(W&~f0.0) sel (16)                r33:uw        r32:uw            r31:uw          {I@3}',
  ]);
  assert.deepEqual(out.map((l) => column(l, ' (16)')), [13, 13, 13]);
  assert.deepEqual([column(out[0], 'r8 '), column(out[1], 'r4 '), column(out[2], 'r33')], [34, 34, 34]);
  assert.deepEqual([column(out[1], 'r6'), column(out[2], 'r31')], [72, 72]);
  assert.deepEqual(out.map((l) => l.indexOf('{')), [82, 82, 82]);
});

test('an outlier overflows instead of widening the column', () => {
  const lines = [
    '        mov (16)                  r8            r0.1<0>                           {Compacted}',
    '        load_cmask.tgm.d32.xy.a32.ca.ca.bti[3] (8) r20:2 r12:4',
    '        load.slm.d32x4.a32 (16)   r10:8   r8:2',
  ];
  const out = format(lines);
  assert.equal(column(out[0], 'r8 '), 34);
  assert.equal(out[1], lines[1]);
  assert.equal(out[2], lines[2]);

  // With the limit raised, the long opcode sets the column for other sends, not for ALU lines.
  const wide = format(lines, { ...DEFAULT_FORMAT, maxOverflow: 40 });
  assert.equal(column(wide[0], 'r8 '), 34);
  assert.equal(column(wide[2], 'r10:8'), column(wide[1], 'r20:2'));
});

test('send comments line up, unless that is turned off', () => {
  const lines = [
    '        send.ugm (16)             r6      r2     null:0  0x00000000  0x62100500   {I@1,$1}  // wr:1+0, rd:1; a',
    '        send.ugm (16)             r7      r2     null:0  0x00040000  0x62100500   {$3}  // wr:1+0, rd:1; b',
    '        send.urb (8)              null    r13            0x00000000  0x12080007  // wr:9h+0, rd:0; c',
  ];
  assert.deepEqual(format(lines).map((l) => l.indexOf('//')), [92, 92, 92]);
  assert.deepEqual(format(lines, { ...DEFAULT_FORMAT, alignComments: false }), lines);
});

test('formatting a selection rewrites only those lines but uses the shader\'s columns', () => {
  const lines = [
    '        mov (16)                  r4            r[a0.0 + 32]<VxH;1,0>:f r6 {I@1}',
    '        mov (16)                  r1            r2                r3',
    '        mov (16)                  r5            r6                r7',
  ];
  const out = format(lines, DEFAULT_FORMAT, { start: 1, end: 1 });
  assert.deepEqual([out[0], out[2]], [lines[0], lines[2]]);
  assert.equal(column(out[1], 'r3'), 72);
});

test('lines that are not understood are left alone', () => {
  const lines = [
    'Native code for unnamed compute shader  (src_hash 0x1)',
    '  // 78   cycles',
    '        mov (16)   r1   %%bogus   {I@1}',
    'L0:    // 300 cycles',
    '        vec4 32 ssa_12 = iadd   ssa_3, ssa_9',
    '    ERROR:   something',
    '',
  ];
  assert.deepEqual(format(lines), lines);
});
