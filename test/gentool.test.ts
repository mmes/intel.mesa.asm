// gentool bridge tests. The ones that run gentool need its path in the
// GENTOOL environment variable and are skipped without it:
//   GENTOOL=~/mesa/build/src/intel/compiler/gen/gentool npm test

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {
  assemble, disassemble, GentoolError, instructionText, overlayDisassembly, parseErrors, prepareForAssembly, regionDiagram,
  type Gentool,
} from '../src/backend/gentool.ts';
import { parseDocument } from '../src/parser/parse.ts';

const SAMPLES = path.join(import.meta.dirname, 'corpus', 'samples');
const samples = fs.readdirSync(SAMPLES).filter((f) => f.endsWith('.asm')).sort();
const read = (file: string) => fs.readFileSync(path.join(SAMPLES, file), 'utf8').split('\n');

const tool: Gentool | undefined = process.env.GENTOOL
  ? { path: process.env.GENTOOL, platform: process.env.GENTOOL_PLATFORM ?? 'ptl' }
  : undefined;
const skip = tool ? false : 'set GENTOOL to run';

test('a dump is reduced to what gentool accepts, line for line', () => {
  const lines = [
    'Native code for unnamed compute shader  (src_hash 0x1)',
    'SIMD16 shader: 3 instructions. 1 loops.',
    '',
    '// 78 cycles',
    '(W)     mov (16)                  r1            r0.1<0>                           {Compacted}',
    'L0: // 260 cycles',
    '        send.ugm (16)             r6      r2     null:0  0x00000000  0x62100500   {Compacted,I@1,$1}  // wr:1+0, rd:1; load',
    'tgl | 40 00 03 00 | (W)     add (8)     r5   r6   0x0000002a  {$1.dst}',
    'compiled in 10.6 ms',
  ];
  const doc = parseDocument(lines);
  assert.deepEqual(prepareForAssembly(lines, doc, doc.shaders[0]).split('\n'), [
    '', '', '', '',
    '(W)     mov (16)                  r1            r0.1<0>',
    'L0:',
    '        send.ugm (16)             r6      r2     null:0  0x00000000  0x62100500   {I@1,$1}',
    '(W)     add (8)     r5   r6   0x0000002a  {$1.dst}',
    '',
  ]);
  assert.equal(instructionText(lines, doc, 6), 'send.ugm (16)             r6      r2     null:0  0x00000000  0x62100500   {I@1,$1}');
  assert.equal(instructionText(lines, doc, 3), undefined);
});

test('gentool errors are placed on the lines they are about', () => {
  const lines = [
    'Native code for unnamed compute shader  (src_hash 0x1)',
    '',
    'L0:',
    '        mov (16)                  r1            r2',
    '// a comment',
    '        while (16)                            L0',
    '        mov (16)                  r1<2>:f       r2:f',
  ];
  const [shader] = parseDocument(lines).shaders;

  assert.deepEqual(parseErrors('gentool asm: parse failed\n<stdin>:4: unknown LSC symbolic opcode \'bogus\'', shader),
    [{ line: 3, message: 'unknown LSC symbolic opcode \'bogus\'' }]);

  // A validation failure prints the program back with errors under the instructions.
  const validation = [
    'gentool asm: validation failed',
    '',
    'L0:',
    '        mov (16|M0)               r1.0<1>:ud    r2.0<1;1,0>:ud',
    '        while (16|M0)                         L0',
    '        mov (16|M0)               r1.0<2>:f     r2.0<1;1,0>:f',
    '    ERROR: first',
    '    ERROR: second',
  ].join('\n');
  assert.deepEqual(parseErrors(validation, shader), [{ line: 6, message: 'first' }, { line: 6, message: 'second' }]);
  assert.deepEqual(parseErrors('something unexpected', shader), [{ line: 0, message: 'something unexpected' }]);
});

test('a re-print is laid over the original line for line', () => {
  const lines = [
    'Native code for unnamed compute shader  (src_hash 0x1)',
    '',
    '// 78 cycles',
    'L7: // 260 cycles',
    '        send.ugm (16)             r6      r2     null:0  0x00000000  0x62100500   {$1}  // wr:1+0, rd:1; load',
    '',
    'L9:',
    '        while (16)                            L7',
    'trailing text',
  ];
  const [shader] = parseDocument(lines).shaders;
  // What gentool prints: its own label numbers, its own spacing, no comments or blank lines kept.
  const printed = [
    'L0:',
    '        load.ugm.d32.a32.bti[0] (16) r6:1  r2:1                                   {$1}',
    'L1:',
    '        while (16)                            L0',
    '',
  ].join('\n');
  assert.deepEqual(overlayDisassembly(lines, shader, printed), [
    lines[0], '', lines[2], lines[3],
    '        load.ugm.d32.a32.bti[0] (16) r6:1  r2:1                                   {$1}',
    '', 'L9:',
    '        while (16)                            L7',
  ]);
  // One instruction short, or a label short: no line-for-line correspondence.
  assert.equal(overlayDisassembly(lines, shader, printed.replace(/^.*load.*\n/m, '')), undefined);
  assert.equal(overlayDisassembly(lines, shader, printed.replace('L1:\n', '')), undefined);
});

test('a missing gentool is reported as such', async () => {
  const lines = ['        mov (16)   r1   r2'];
  const doc = parseDocument(lines);
  await assert.rejects(
    assemble({ path: '/nonexistent/gentool', platform: 'nvl' }, lines, doc, doc.shaders[0]),
    (error: unknown) => error instanceof GentoolError && error.kind === 'missing' && /file not found/.test(error.message));
});

// What a dump and its re-disassembly should agree on: everything except
// compaction, which gentool asm does not do, comments and blank lines.
//
// Two further differences are gentool's own (seen with a Mesa build from
// October 2026 on ptl and bmg) and are masked here so the rest is still compared exactly:
// a `send.ugm` comes back with ExBSO set, and the last source of a SIMD32
// three-source instruction written without a region comes back as `<0>`,
// as does every operand of a `dpas`.
// A third is inherent in the encoding: when a pipe distance shares the
// annotation with a token, the pipe is not encoded, so `{I@2,$6.src}` comes
// back as `{@2,$6.src}`.
const comparable = (text: string[]) => text
  .map((l) => l.replace(/\s*\/\/.*$/, '').replace(/\{([^}]*)\}/, (_, o: string) => {
    const kept = o.split(',').filter((x) => x !== 'Compacted' && x !== 'ExBSO')
      .map((x) => (o.includes('$') ? x.replace(/^[FILMSA]@/, '@') : x));
    return kept.length ? `{${kept.join(',')}}` : '';
  }).replace(/\s+/g, ' ').trimEnd())
  .map((l) => (/^ ?(?:\([^)]*\) )?(?:add3|mad|bfn\S*|bfe|bfi2|csel|dp4a|dpas\S*) /.test(l) ? l.replace(/<0>(:\w+)?( \{[^}]*\})?$/, '$1$2') : l))
  .map((l) => (/ dpas\S* /.test(l) ? l.replace(/<0(?:;0,0)?>/g, '') : l))
  .filter((l) => l && (/^L\d+:/.test(l) || /\(\d+(\|M\d+)?\)/.test(l)));

for (const file of samples) {
  test(`${file} assembles, and disassembles back to itself`, { skip }, async () => {
    const lines = read(file);
    const doc = parseDocument(lines);
    const result = await assemble(tool!, lines, doc, doc.shaders[0]);
    assert.deepEqual(result.errors, []);
    assert.equal(result.binary!.length, doc.shaders[0].instructions.length * 16);

    const again = (await disassemble(tool!, result.binary!)).split('\n');
    const original = lines.slice(doc.shaders[0].startLine + 1, doc.shaders[0].endLine + 1)
      .filter((_, i) => doc.kinds[doc.shaders[0].startLine + 1 + i] === 'instruction' || doc.kinds[doc.shaders[0].startLine + 1 + i] === 'label');
    assert.deepEqual(comparable(again), comparable(original));

    // Every form gentool prints is one this extension's parser understands.
    for (const options of [{ verbose: true }, { translatedSends: true }, { hex: true }]) {
      const text = (await disassemble(tool!, result.binary!, options)).split('\n');
      const parsed = parseDocument(text);
      assert.equal(parsed.shaders[0].instructions.length, doc.shaders[0].instructions.length, JSON.stringify(options));
      assert.ok(parsed.shaders[0].instructions.every((i) => i.ok), JSON.stringify(options));
    }

    // Each form can be laid over the original with instructions and labels on their own lines.
    for (const options of [{ verbose: true }, { translatedSends: true }, { hex: true }]) {
      const overlay = overlayDisassembly(lines, doc.shaders[0], await disassemble(tool!, result.binary!, options));
      assert.ok(overlay, JSON.stringify(options));
      const view = parseDocument([...lines.slice(0, doc.shaders[0].startLine), ...overlay]);
      assert.equal(overlay.length, doc.shaders[0].endLine - doc.shaders[0].startLine + 1);
      assert.deepEqual(view.shaders[0].instructions.map((i) => i.line), doc.shaders[0].instructions.map((i) => i.line));
      assert.deepEqual([...view.shaders[0].labels].map(([name, l]) => [name, l.span.line]),
        [...doc.shaders[0].labels].map(([name, l]) => [name, l.span.line]));
      assert.ok(view.shaders[0].instructions.every((i) => i.labels.every((l) => view.shaders[0].labels.has(l.name))));
    }
  });
}

test('gentool problems come back on the right lines', { skip }, async () => {
  const lines = [
    'L0:',
    '        mov (16)                  r1            r2',
    '        bogus (1)                 r1',
    '        while (16)                            L0',
  ];
  const doc = parseDocument(lines);
  const parse = await assemble(tool!, lines, doc, doc.shaders[0]);
  assert.equal(parse.binary, undefined);
  assert.deepEqual(parse.errors.map((e) => e.line), [2]);

  const invalid = [...lines.slice(0, 2), '        mov (16)                  r1<2>:f       r2:f', lines[3]];
  const invalidDoc = parseDocument(invalid);
  const validation = await assemble(tool!, invalid, invalidDoc, invalidDoc.shaders[0]);
  assert.ok(validation.errors.length >= 1);
  assert.ok(validation.errors.every((e) => e.line === 2));

  await assert.rejects(
    assemble({ ...tool!, platform: 'zzz' }, lines, doc, doc.shaders[0]),
    (error: unknown) => error instanceof GentoolError && /platform/.test(error.message));
});

test('region diagrams', { skip }, async () => {
  const diagram = await regionDiagram(tool!, 'add (16) r4.1<2>:uw r4.1<2>:uw r6<2>:uw');
  assert.match(diagram!, /^dst\n\|.*\| r4\n\nsrc0\n/);
  assert.equal(await regionDiagram(tool!, 'while (16) L0'), undefined);
});
