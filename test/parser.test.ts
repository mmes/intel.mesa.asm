// Parser and analysis tests. Run with `npm test`; Node executes the
// TypeScript directly.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { foldingRanges } from '../src/analysis/folding.ts';
import { occurrences, targetAt } from '../src/analysis/references.ts';
import { parseDocument, parseInstruction } from '../src/parser/parse.ts';

const CORPUS = path.join(import.meta.dirname, 'corpus');
const read = (...parts: string[]) => fs.readFileSync(path.join(CORPUS, ...parts), 'utf8').split('\n');
const files = (dir: string) => fs.readdirSync(path.join(CORPUS, dir)).filter((f) => /\.(txt|asm)$/.test(f)).sort();

for (const file of files('mesa')) {
  test(`every case in ${file} parses`, () => {
    const lines = read('mesa', file);
    const doc = parseDocument(lines);
    const bad = lines.flatMap((text, i) =>
      text.trim() && !(doc.kinds[i] === 'instruction' && doc.instructionAt[i]!.ok) ? [`${i + 1}: ${text}`] : []);
    assert.deepEqual(bad, []);
  });
}

for (const file of files('samples')) {
  test(`every line of ${file} is understood`, () => {
    const lines = read('samples', file);
    const doc = parseDocument(lines);
    const bad = lines.flatMap((text, i) => {
      if (!text.trim()) return [];
      const kind = doc.kinds[i];
      const understood = kind === 'instruction' ? doc.instructionAt[i]!.ok : kind !== 'other';
      return understood ? [] : [`${i + 1} (${kind}): ${text}`];
    });
    assert.deepEqual(bad, []);
    assert.equal(doc.shaders.length, 1);
  });
}

const at = (text: string) => {
  const inst = parseInstruction(text, 0);
  assert.ok(inst, text);
  return inst;
};

test('fields of an ALU instruction', () => {
  const inst = at('(W&~f0.0) add.sat (8|M16) (ge)f1.0 r1.2<2>:uw  -r2<8;8,1>:f  0x3f800000:f  {Compacted,I@2,$11.src}');
  assert.equal(inst.ok, true);
  assert.deepEqual([inst.opcode.name, inst.opcode.suffix], ['add', '.sat']);
  assert.deepEqual([inst.execSize, inst.channelOffset, inst.noMask], [8, 16, true]);
  assert.deepEqual([inst.predicate?.file, inst.predicate?.nr, inst.predicate?.subnr], ['f', 0, 0]);
  assert.deepEqual([inst.cmod?.condition, inst.cmod?.flag?.nr, inst.cmod?.flag?.access], ['ge', 1, 'write']);
  assert.deepEqual(inst.operands.map((o) => [o.kind, o.type, o.region]), [
    ['register', 'uw', '<2>'], ['register', 'f', '<8;8,1>'], ['immediate', 'f', undefined]]);
  assert.deepEqual(inst.operands[0].registers.map((r) => [r.file, r.nr, r.subnr, r.access]), [['r', 1, 2, 'write']]);
  assert.equal(inst.operands[1].registers[0].access, 'read');
  assert.deepEqual(inst.flags.map((f) => f.name), ['Compacted']);
  assert.deepEqual([inst.swsbRegDist?.pipe, inst.swsbRegDist?.distance], ['I', 2]);
  assert.deepEqual([inst.swsbToken?.id, inst.swsbToken?.mode], [11, 'src']);
});

test('spans point at the text they describe', () => {
  const text = '(f0.0)  sel (16)                  r33:uw        r32:uw            r31:uw          {I@3,$7}';
  const inst = at(text);
  const slice = (s: { start: number; end: number }) => text.slice(s.start, s.end);
  assert.equal(slice(inst.opcode.span), 'sel');
  assert.equal(slice(inst.predicate!.span), 'f0.0');
  assert.deepEqual(inst.operands.map((o) => slice(o.span)), ['r33:uw', 'r32:uw', 'r31:uw']);
  assert.deepEqual(inst.registers.map((r) => slice(r.span)), ['f0.0', 'r33', 'r32', 'r31']);
  assert.equal(slice(inst.swsbRegDist!.span), 'I@3');
  assert.equal(slice(inst.swsbToken!.span), '$7');
});

test('sends, indirect operands and translated sends', () => {
  const send = at('(W)     send.ugm (1)   r90   r26   null:0  0x00080000:a0.2  0x42100500   {ExBSO,$2}  // wr:1+a0.2, rd:1; load.ugm');
  assert.equal(send.ok, true);
  assert.deepEqual(send.registers.map((r) => `${r.file}${r.nr}:${r.access}`),
    ['r90:write', 'r26:read', 'null0:read', 'a0:read']);
  assert.equal(send.comment !== undefined, true);

  const gather = at('(W)     send.slm (1)   null   r[s0.0] null:0 0x00000000  0x08000504   {A@1,$2}');
  assert.deepEqual(gather.operands[1].registers.map((r) => [r.file, r.nr, r.subnr]), [['s', 0, 0]]);

  const indirect = at('        mov (16)   r4   -(abs)r[a0.0 + 32]<VxH;1,0>:f');
  assert.deepEqual([indirect.ok, indirect.operands.length, indirect.operands[1].region], [true, 2, '<VxH;1,0>']);

  const store = at('bmg | 31 00 00 00 00 00 00 00 0c 50 0e f4 44 14 80 00 |  store_block2d.ugm.d16.a64.uc.uc (1)  [r80:1] r20:8  {ExBSO}');
  assert.deepEqual([store.opcode.name, store.operands[0].kind], ['store_block2d', 'memory']);
  assert.deepEqual(store.registers.map((r) => r.access), ['read', 'read']);

  assert.equal(at('        bfn.(a ^ ~b & c) (8)      r1    r2    r3    r4<0>').operands.length, 4);
  assert.equal(at('skl | 7e 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 |         nop').opcode.name, 'nop');
});

test('text that is not assembly is not an instruction', () => {
  for (const text of [
    'vec4 32 ssa_12 = iadd ssa_3, ssa_9',
    'compiled in 10.6 ms (2 shaders)',
    'block b0:  // preds:',
    '',
  ]) {
    assert.equal(parseInstruction(text, 0), undefined, text);
  }
});

test('structure of a shader with a loop', () => {
  const lines = read('samples', 'loop.asm');
  const doc = parseDocument(lines);
  const [shader] = doc.shaders;
  assert.match(shader.name, /^unnamed compute shader/);
  assert.equal(shader.summary, 'SIMD16, 16 instructions');
  assert.equal(shader.headerLine, 0);
  assert.deepEqual([...shader.labels.keys()], ['L0', 'L1']);

  const loopHead = shader.labels.get('L0')!.span.line;
  const loopEnd = shader.instructions.find((i) => i.opcode.name === 'while')!.line;
  const folds = foldingRanges(doc);
  assert.deepEqual(folds.find((f) => f.start === loopHead), { start: loopHead, end: loopEnd });
  assert.deepEqual(folds[0], { start: 0, end: shader.endLine });

  // `(f0.0) break (16) jip:L1 uip:L1`: both operands, then the definition below them.
  const brk = shader.instructions.find((i) => i.opcode.name === 'break')!;
  const label = targetAt(doc, brk.line, brk.labels[0].span.start);
  assert.equal(label?.kind, 'label');
  assert.deepEqual(occurrences(label!).map((o) => o.access), ['read', 'read', 'write']);

  // Every `$0` and `$0.dst`, with the send that sets it marked as the definition.
  const setter = shader.instructions.find((i) => i.swsbToken?.id === 0 && i.swsbToken.mode === 'set')!;
  const uses = occurrences(targetAt(doc, setter.line, setter.swsbToken!.span.start)!);
  assert.deepEqual(uses.map((o) => lines[o.span.line].slice(o.span.start, o.span.end)), ['$0', '$0.dst']);
  assert.deepEqual(uses.map((o) => o.access), ['write', 'read']);

  // r14 is the loop counter: written by the initial mov and the increment.
  const init = shader.instructions.find((i) => i.operands[0]?.text === 'r14')!;
  const reg = occurrences(targetAt(doc, init.line, init.operands[0].span.start)!);
  assert.ok(reg.every((o) => lines[o.span.line].slice(o.span.start, o.span.end) === 'r14'));
  assert.equal(reg.filter((o) => o.access === 'write').length, 2);
  assert.equal(reg.length, 5);
});

test('the cursor on an opcode selects every register its operands name', () => {
  const lines = [
    '(W)     mov (16)                  r32:hf       r20:hf',
    '(W)     mov (16)                  r48:f        0x00000000:f',
    '(f0.0)  mov (16)                  r50           r51',
    '(W)     dpas.8x8 (16)             r40:f          r48:f            r32:hf           r56:hf {$5}',
    '(f0.0)  add (16)                  r7:f          r40:f              r56.2<0>:f       {$5.dst}',
  ];
  const doc = parseDocument(lines);
  const target = targetAt(doc, 3, lines[3].indexOf('dpas') + 2);
  assert.equal(target?.kind, 'instruction');
  const found = occurrences(target!).map((o) => `${o.span.line}:${lines[o.span.line].slice(o.span.start, o.span.end)}:${o.access}`);
  assert.deepEqual(found, [
    '0:r32:write', '1:r48:write',
    '3:r40:write', '3:r48:read', '3:r32:read', '3:r56:read',
    '4:r40:read', '4:r56.2:read',
  ]);
  // The exec size belongs to the opcode; the gap before the operands does not.
  assert.equal(targetAt(doc, 3, lines[3].indexOf('(16)') + 1)?.kind, 'instruction');
  assert.equal(targetAt(doc, 3, 30), undefined);
});

test('if / else / endif fold separately and nest', () => {
  const doc = parseDocument([
    '(f0.0)  if (16)                               jip:L0              uip:L1',
    '        mov (16)                  r1            r2',
    '(f0.1)  if (16)                               jip:L2              uip:L2',
    '        mov (16)                  r3            r4',
    '        mov (16)                  r3            r5',
    '',
    'L2:',
    '        endif (16)                            L2',
    '',
    'L0:',
    '        else (16)                             jip:L1              uip:L1',
    '        mov (16)                  r1            r6',
    '        mov (16)                  r1            r7',
    '',
    'L1:',
    '        endif (16)                            L1',
  ]);
  const folds = foldingRanges(doc).map((f) => [f.start, f.end]);
  assert.deepEqual(folds, [[0, 15], [2, 4], [0, 7], [10, 12]]);
});

test('validator errors attach to the instruction above', () => {
  const doc = parseDocument([
    'Native code for unnamed compute shader  (src_hash 0x1)',
    '        mov (16)                  r1:f          r2:d',
    '    ERROR: Destination stride must be 1',
    '    ERROR: second problem',
    '        mov (16)                  r3            r4',
  ]);
  const [first, second] = doc.shaders[0].instructions;
  assert.deepEqual(first.errors, [
    { line: 2, message: 'Destination stride must be 1' }, { line: 3, message: 'second problem' }]);
  assert.deepEqual(second.errors, []);
});

test('several shaders in one file keep separate label scopes', () => {
  const one = read('samples', 'loop.asm');
  const doc = parseDocument([...one, ...one]);
  assert.equal(doc.shaders.length, 2);
  assert.equal(doc.shaders[1].headerLine, one.length);
  const second = doc.shaders[1].labels.get('L0')!;
  const uses = occurrences(targetAt(doc, second.span.line, 0)!);
  assert.ok(uses.length > 1 && uses.every((o) => o.span.line >= one.length));
});

test('a 12 000-line dump parses well inside a second', () => {
  const one = read('samples', 'systolic.asm');
  const lines = Array.from({ length: 300 }, () => one).flat();
  assert.ok(lines.length > 12000);
  const start = performance.now();
  const doc = parseDocument(lines);
  foldingRanges(doc);
  const ms = performance.now() - start;
  assert.ok(ms < 1000, `${ms.toFixed(0)} ms`);
});
