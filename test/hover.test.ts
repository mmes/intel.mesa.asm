// Hover and send-decoder tests.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { hoverAt, type HoverContext } from '../src/hover/hover.ts';
import { decodeLsc } from '../src/hover/lsc.ts';
import { OPCODES } from '../src/hover/opcodes.ts';
import { analyzeSend } from '../src/hover/send.ts';
import { parseDocument } from '../src/parser/parse.ts';
import type { Generation } from '../src/platform.ts';

const ROOT = path.join(import.meta.dirname, '..');
const CORPUS = path.join(ROOT, 'test', 'corpus');
const corpus = ['mesa', 'samples'].flatMap((dir) =>
  fs.readdirSync(path.join(CORPUS, dir)).filter((f) => /\.(txt|asm)$/.test(f)).sort().map((f) => path.join(dir, f)));
const read = (file: string) => fs.readFileSync(path.join(CORPUS, file), 'utf8').split('\n');

function context(lines: string[], generation: Generation = 'xe3'): HoverContext {
  return { lines, doc: parseDocument(lines), generation, link: (line) => `#L${line + 1}` };
}

/** Hover with the cursor on the first occurrence of `token` in the first line matching `pattern`. */
function hover(lines: string[], pattern: RegExp, token: string): string {
  const line = lines.findIndex((l) => pattern.test(l));
  assert.ok(line >= 0, `no line matches ${pattern}`);
  const result = hoverAt(context(lines), line, lines[line].indexOf(token) + 1);
  assert.ok(result, `no hover on ${token}`);
  return result.markdown;
}

test('every Mesa opcode has a description, and nothing else does', () => {
  const mesa = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'opcodes.json'), 'utf8')).opcodes.map((o: { name: string }) => o.name);
  assert.deepEqual(Object.keys(OPCODES).sort(), [...mesa].sort());
});

test('decoded sends agree with what Mesa printed in the comment', () => {
  let names = 0;
  let lengths = 0;
  const wrong: string[] = [];
  for (const file of corpus) {
    const lines = read(file);
    for (const shader of parseDocument(lines).shaders) {
      for (const inst of shader.instructions) {
        const info = analyzeSend(inst, lines[inst.line], 'xe3');
        if (!info || !inst.comment) continue;
        const comment = lines[inst.line].slice(inst.comment.start);
        const where = `${file}:${inst.line + 1}`;

        // `// wr:1h+0, rd:2; …`: message length, header, extended length, response length.
        const m = /wr:(\d+)(h?)\+(\d+|a0\.\d+), rd:(\d+)/.exec(comment);
        if (m && info.lengths) {
          lengths++;
          const lsc = info.message?.opcode !== undefined;
          const got = [info.lengths.messageLength, info.lengths.headerPresent && !lsc, info.lengths.responseLength];
          if (String(got) !== String([Number(m[1]), m[2] === 'h', Number(m[4])])) wrong.push(`${where} lengths ${got}`);
          if (/^\d/.test(m[3]) && info.extendedLength !== Number(m[3])) wrong.push(`${where} ex length ${info.extendedLength}`);
        }
        if (info.message && info.printedName) {
          names++;
          if (info.message.name !== info.printedName) wrong.push(`${where} ${info.message.name} != ${info.printedName}`);
        }
      }
    }
  }
  assert.deepEqual(wrong.slice(0, 10), []);
  assert.ok(names > 15 && lengths > 2000, `${names} names, ${lengths} lengths`);
});

test('LSC descriptor fields', () => {
  const block = decodeLsc('ugm', 0x6240f500, { imm: 0x01000000 }, 0, true);
  assert.equal(block.name, 'load.ugm.d32x64t.a32.bti[1]');
  assert.match(block.fields.find((f) => f.label === 'Vector size')!.value, /^64 elements, transposed/);
  assert.match(block.fields.find((f) => f.label === 'Surface')!.value, /binding table entry 1/);

  const vnni = decodeLsc('ugm', 0x02800283, { imm: 0 }, 0, true);
  assert.equal(vnni.name, 'load_block2d.ugm.d16v.a64');
  assert.match(vnni.fields.find((f) => f.label === 'VNNI')!.value, /^yes/);
  assert.match(decodeLsc('ugm', 0x02800203, { imm: 0 }, 0, true).fields.find((f) => f.label === 'VNNI')!.value, /^no/);

  assert.equal(decodeLsc('slm', 0x0210011f, { imm: 0 }, 0, true).name, 'fence.slm.threadgroup.none');
  assert.equal(decodeLsc('ugm', 0x04140588, { imm: 0 }, 0, true).name, 'atomic_inc.ugm.d32.a64.uc.wb');
  assert.equal(decodeLsc('ugm', 0x42109500, { imm: 0, reg: 4 }, undefined, true).name, 'load.ugm.d32x2t.a32.ss[a0.2]');
  assert.equal(decodeLsc('ugm', 0x62000504, { imm: 0x010c0040 }, 1, true).name, 'store.ugm.d32.a32.bti[1][A+0xc0]');
  // An SLM base offset has no name in the printer's syntax, but the hover still reports it.
  const slm = decodeLsc('slm', 0x0a00f504, { imm: 0x04000000 }, 0, true);
  assert.equal(slm.name, 'store.slm.d32x64t.a32.?');
  assert.match(slm.fields.at(-1)!.value, /offset 0x4000/);
});

test('a hover can be built on every token of every corpus line', () => {
  for (const file of corpus) {
    const lines = read(file);
    const ctx = context(lines);
    for (const shader of ctx.doc.shaders) {
      for (const inst of shader.instructions) {
        const whole = hoverAt(ctx, inst.line, inst.opcode.span.start);
        assert.ok(whole?.markdown.startsWith('**`'), `${file}:${inst.line + 1}`);
        for (const operand of inst.operands) assert.ok(hoverAt(ctx, inst.line, operand.span.start + 1));
        const spans = [inst.swsbToken?.span, inst.swsbRegDist?.span, inst.prefix, inst.exec, ...inst.flags.map((f) => f.span)];
        for (const span of spans) {
          if (span) assert.ok(hoverAt(ctx, inst.line, span.start + 1));
        }
      }
    }
  }
});

const SYSTOLIC = read('samples/systolic.asm');

test('dpas hover names the operands, their extent and where they come from', () => {
  const text = hover(SYSTOLIC, /dpas\.8x8/, 'dpas');
  assert.match(text, /Systolic depth 8, repeat count 8/);
  assert.match(text, /\| destination \(accumulator out\) \| `r40:f` \| `r40\.0<1>:f`, `r40`–`r47` \(8 registers, 512 bytes\)/);
  assert.match(text, /\| accumulator in \| `r48:f` \| `r48\.0:f`, `r48`–`r55` \(8 registers, 512 bytes\) \| \[line 31\]\(#L31\)/);
  assert.match(text, /\| B \(VNNI layout\) \| `r32:hf` \| .*`r32`–`r39` \(8 registers, 512 bytes\) \| \[line 30\]/);
  assert.match(text, /\| A \(row-major\) \| `r56:hf` \| .*`r56`–`r59` \(4 registers, 256 bytes\) \| not written above/);
  assert.match(text, /`\$3`: this instruction owns scoreboard token 3/);
  assert.match(text, /\[line 33\]\(#L33\) `\(W\) mov \(1\) s0:uq 0x000000002b2a2928:uq`, for its result/);
  assert.match(text, /`F@1`: .* By count that is \[line 31\]/);
});

test('send hover decodes the message and sizes the payload', () => {
  const load = hover(SYSTOLIC, /send\.ugm/, 'send');
  assert.match(load, /\*\*Message\*\* `load\.ugm\.d32x16t\.a64`/);
  assert.match(load, /\| Response \| `r24` \| 1 register \(64 bytes\)/);
  assert.match(load, /\| Payload \| `r20` \| 1 register \(64 bytes\) \| \[line 28\]/);
  assert.match(load, /\| Vector size \| 16 elements, transposed/);
  assert.doesNotMatch(load, /own comment says/);

  const gather = hover(SYSTOLIC, /send\.slm.*r\[s0/, 'send');
  assert.match(gather, /4 registers \(256 bytes\); gathered from `r40`, `r41`, `r42`, `r43`/);

  const eot = hover(SYSTOLIC, /send\.gtwy/, 'send');
  assert.match(eot, /\*\*Message\*\* `open \(16\)`/);
  assert.match(eot, /`EOT`: End of thread/);

  // The same line read as Xe-HPG has 32-byte registers.
  const line = SYSTOLIC.findIndex((l) => /send\.ugm/.test(l));
  const xe = hoverAt(context(SYSTOLIC, 'xe-hpg'), line, SYSTOLIC[line].indexOf('send') + 1)!.markdown;
  assert.match(xe, /1 register \(32 bytes\)/);
});

test('scoreboard waits link to the owner of the token', () => {
  const lines = read('samples/loop.asm');
  const wait = hover(lines, /mul.*\{\$0\.dst\}/, '$0.dst');
  assert.match(wait, /waits until the owner of token 0 has written its destination/);
  assert.match(wait, /Owner: \[line 19\]\(#L19\) `send\.ugm \(16\) r18 r16/);
  const dist = hover(lines, /add.*\{Compacted,I@2\}/, 'I@2');
  assert.match(dist, /2 back in the integer pipe has completed\. By count that is \[line 16\]\(#L16\) `shl \(16\) r16:d r14:d 0x00000002`\.$/);
});

test('operand, immediate, label and execution hovers', () => {
  const lines = [
    'L0:',
    '(W)     mov (16)                  r8            r0.1<0>                           {Compacted}',
    '        mul (16)                  r9:f          r8:f              0x3fb8aa3b:f',
    '(W&~f0.0) add (8|M8)   (lt)f1.0   r10.4<2>:uw   -r9<4;2,2>:uw     -5:w',
    '(W)     mov (1)                   s0:uq         0x000000002b2a2928:uq',
    '        bfn.(a ^ ~b & c) (8)      r1            r2                r3                r4<0>',
    '        while (16)                            L0',
  ];
  const scalar = hover(lines, /r0\.1<0>/, 'r0.1');
  assert.match(scalar, /In full: `r0\.1<0;1,0>:ud`/);
  assert.match(scalar, /not printed; `:ud` is the default/);
  assert.match(scalar, /scalar: every channel reads element 0/);
  assert.match(scalar, /Covers: bytes 4–7 of `r0`/);
  assert.match(scalar, /not written above \(thread payload/);

  assert.match(hover(lines, /mul/, '0x3fb8aa3b'), /value 1\.442695\d+ \(the printed digits are the raw IEEE bits\)/);
  assert.match(hover(lines, /mul/, 'r8:f'), /Last written: \[line 2\]\(#L2\) `\(W\) mov \(16\) r8 r0\.1<0>`/);

  const region = hover(lines, /add \(8/, '-r9');
  assert.match(region, /channel i reads element ⌊i\/2⌋·4 \+ \(i mod 2\)·2/);
  assert.match(region, /Covers: bytes 0–29 of `r9`/);
  assert.match(region, /Negated/);
  assert.match(hover(lines, /add \(8/, 'r10.4'), /Covers: bytes 8–37 of `r10`/);
  assert.match(hover(lines, /add \(8/, '-5:w'), /hex 0xfffb/);

  const exec = hover(lines, /add \(8/, '(8|M8)');
  assert.match(exec, /8 channels \(channels 8–15 of the thread\)/);
  assert.match(exec, /NoMask and predicated: a channel runs when its bit in `f0\.0` is clear/);
  assert.match(exec, /sets a channel's bit in `f1\.0` when `the result < 0`/);

  assert.match(hover(lines, /s0:uq/, '0x0000'), /register list, lowest byte first: r40, r41, r42, r43, r0, r0, r0, r0/);

  const bfn = hover(lines, /bfn/, 'bfn');
  assert.match(bfn, /\| 0 \| 0 \| 1 \| 1 \|/);
  assert.match(bfn, /\| 1 \| 0 \| 1 \| 0 \|/);

  const label = hover(lines, /while/, 'L0');
  assert.match(label, /label at \[line 1\]\(#L1\)/);
  assert.match(label, /Head of a loop/);
  assert.match(hover(lines, /^L0:/, 'L0'), /Named by:\n\n- \[line 7\]/);
});

test('instructions are assigned to pipes as Mesa assigns them', async () => {
  const { pipeOf, regDistTarget } = await import('../src/analysis/pipes.ts');
  const { definitionAt } = await import('../src/analysis/references.ts');
  const { parseInstruction } = await import('../src/parser/parse.ts');
  const pipe = (text: string, generation: Generation) => pipeOf(parseInstruction(text, 0)!, generation);

  assert.equal(pipe('        add (16)   r1:d   r2:d   r3:d', 'xe3'), 'I');
  assert.equal(pipe('        add (16)   r1:f   r2:f   r3:f', 'xe3'), 'F');
  assert.equal(pipe('        cmp (16) (ge)f0.0 null r14 r2<0>', 'xe3'), 'I');
  assert.equal(pipe('(f0.0)  break (16)        jip:L1    uip:L1', 'xe3'), 'I');
  assert.equal(pipe('        mov (16)   r1:df  r2:f', 'xe3'), 'L');
  assert.equal(pipe('        add (16)   r1:q   r2:q   r3:q', 'xe3'), 'I');
  assert.equal(pipe('        add (16)   r1:q   r2:q   r3:q', 'xe-hpg'), 'L');
  assert.equal(pipe('        mul (16)   r1:d   r2:d   r3:d', 'xe-hpg'), 'L');
  assert.equal(pipe('        mul (16)   r1:d   r2:d   r3:uw', 'xe-hpg'), 'I');
  assert.equal(pipe('        math.exp (16)  r1:f  r2:f  null', 'xe3'), 'M');
  assert.equal(pipe('        math.exp (16)  r1:f  r2:f  null', 'xe-hpg'), 'unordered');
  assert.equal(pipe('(W)     mov (1)   s0:uq   0x000000002b2a2928:uq', 'xe3'), 'S');
  assert.equal(pipe('(W)     mov (1)   s0:uq   0x000000002b2a2928:uq', 'xe2'), 'I');
  assert.equal(pipe('        mov (16)   r1<2>:hf  r2:f', 'xe3'), 'F');
  assert.equal(pipe('        mov (16)   r1<2>:hf  r2:d', 'xe3p'), 'I');
  assert.equal(pipe('        add (16)   r1:d   r2:d   r3:d', 'xe-lp'), 'F');
  assert.equal(pipe('        send.ugm (16)  r6  r2  null:0  0x00000000  0x62100500', 'xe3'), 'unordered');
  assert.equal(pipe('(W)     dpas.8x8 (16)  r40:f  r48:f  r32:hf  r56:hf', 'xe3'), 'unordered');
  assert.equal(pipe('(W)     sync.nop (1)   null', 'xe3'), 'none');
  // A case line's own platform overrides the assumed generation.
  assert.equal(pipe('tgl | 40 00 | add (16)   r1:d   r2:d   r3:d', 'xe3'), 'F');

  const lines = [
    '        mov (16)                  r10:f         r1:f',
    '        add (16)                  r20:d         r2:d              r3:d',
    '(W)     mov (1)                   s0:uq         0x000000002b2a2928:uq',
    '        send.ugm (16)             r30     r2     null:0  0x00000000  0x62100500   {$1}',
    '        mul (16)                  r11:f         r10:f             r4:f            {F@1}',
    '(W)     sync.nop (1)                            null                              {S@1}',
    '        send.slm (16)             null    r[s0.0] null:0 0x00000000  0x08000504   {$2}',
    '        add (16)                  r61:d         r50:d             r51:d           {I@1}',
    'L0:',
    '        add (16)                  r22:d         r20:d             r6:d            {A@3}',
  ];
  const doc = parseDocument(lines);
  const [shader] = doc.shaders;
  const target = (line: number) => regDistTarget(shader, doc.instructionAt[line]!, 'xe3')!;
  // The float pipe skips the integer add, the scalar move and the send.
  assert.deepEqual([target(4).inst.line, target(4).plausible, target(4).acrossControlFlow], [0, true, false]);
  // A sync waits on behalf of the send after it, which gathers through s0.
  assert.deepEqual([target(5).inst.line, target(5).plausible], [2, true]);
  // The nearest integer instruction wrote nothing this add reads.
  assert.deepEqual([target(7).inst.line, target(7).plausible], [1, false]);
  // Any pipe: the add, the mul, then the scalar move. Sends and syncs do not count.
  assert.deepEqual([target(9).inst.line, target(9).acrossControlFlow], [2, true]);

  const hoverText = hoverAt(context(lines), 7, lines[7].indexOf('I@1'))!.markdown;
  assert.match(hoverText, /writes nothing this instruction uses, so the count is probably off/);
  assert.deepEqual(definitionAt(doc, 4, lines[4].indexOf('F@1') + 1, 'xe3'), { line: 0, start: 8, end: 11 });
  assert.match(hoverAt(context(lines), 4, lines[4].indexOf('mul'))!.markdown, /16 channels; .*; float pipe\./);
});
