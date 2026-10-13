// Hover text. Pure functions from the document model to Markdown; the VS Code
// provider in extension.ts only wraps the result.

import { pipeOf, regDistTarget } from '../analysis/pipes.ts';
import { sameRegister } from '../analysis/references.ts';
import type { Instruction, Operand, ParsedDocument, RegisterRef, Shader, Span } from '../parser/model.ts';
import { hasDestination, isBranch, shaderAt } from '../parser/parse.ts';
import { CONDITIONS, FLAGS, MATH_FUNCTIONS, OPCODES, PIPES, SYNC_FUNCTIONS, TYPES } from './opcodes.ts';
import { grfSize, versionOf, type Generation } from '../platform.ts';
import { analyzeSend } from './send.ts';

export interface HoverContext {
  lines: readonly string[];
  doc: ParsedDocument;
  /** The hardware generation to assume for a dump, which does not record its platform. */
  generation: Generation;
  /** A Markdown link target that opens the given line of this document. */
  link: (line: number) => string;
}

export interface HoverResult {
  span: Span;
  markdown: string;
}

interface Scope extends HoverContext {
  shader: Shader;
  inst: Instruction;
  text: string;
}

const inside = (span: Span | undefined, column: number): span is Span =>
  !!span && column >= span.start && column <= span.end;
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
const code = (text: string) => `\`${text}\``;

/** The instruction as short text, without options or comment. */
function quote(ctx: HoverContext, inst: Instruction): string {
  const text = ctx.lines[inst.line];
  const end = inst.options?.start ?? inst.comment?.start ?? text.length;
  const squeezed = text.slice(inst.prefix?.start ?? inst.opcode.span.start, end).replace(/\s+/g, ' ').trim();
  return squeezed.length > 72 ? `${squeezed.slice(0, 70)}…` : squeezed;
}

const lineRef = (ctx: HoverContext, inst: Instruction) =>
  `[line ${inst.line + 1}](${ctx.link(inst.line)}) ${code(quote(ctx, inst))}`;

/** The nearest instruction above that writes the register. Text order; see definitionAt(). */
function lastWriter(s: Scope, ref: RegisterRef): Instruction | undefined {
  for (let i = s.inst.index - 1; i >= 0; i--) {
    const candidate = s.shader.instructions[i];
    if (candidate.registers.some((r) => r.access === 'write' && sameRegister(r, ref))) return candidate;
  }
  return undefined;
}

function origin(s: Scope, operand: Operand): string {
  const sources = operand.registers.filter((r) => r.access === 'read' && r.file !== 'null');
  if (!sources.length) return '';
  return sources.map((ref) => {
    const writer = lastWriter(s, ref);
    const name = s.text.slice(ref.span.start, ref.span.end);
    const prefix = sources.length > 1 ? `${code(name)}: ` : '';
    if (writer) return prefix + lineRef(s, writer);
    return prefix + (ref.file === 'r' ? 'not written above (thread payload, or set later in a loop)' : 'not written above');
  }).join('; ');
}

// ---------------------------------------------------------------------------
// Operands

const OPERAND = /^([-~]?(?:\(abs\))?)(r\[[^\]]*\]|[a-z]+\d*)(?:\.(\d+))?(<[^>]*>)?(\.(?:[xyzw]{1,4}|r))?(?::([a-z]+))?$/;

interface Shape {
  full: string;
  type: string;
  /** Index of the last element any channel touches, when the region makes that computable. */
  lastElement?: number;
  regionNote: string;
  subnr: number;
}

function shapeOf(s: Scope, operand: Operand, isDst: boolean): Shape | undefined {
  const m = OPERAND.exec(operand.text);
  if (!m || operand.kind !== 'register') return undefined;
  const [, modifier, register, sub, region, swizzle, typeSuffix] = m;
  const type = typeSuffix ?? 'ud';
  const exec = s.inst.execSize ?? 1;
  const subnr = Number(sub ?? 0);
  const threeSource = s.inst.operands.length - (hasDestination(s.inst.opcode.name) ? 1 : 0) === 3;
  const bare = register === 'null' || register === 'ip';

  let fullRegion = region ?? '';
  let lastElement: number | undefined;
  let regionNote: string;
  let m2;
  if (isDst) {
    const stride = region ? Number(/<(\d+)>/.exec(region)?.[1] ?? 1) : 1;
    fullRegion = `<${stride}>`;
    lastElement = (exec - 1) * stride;
    regionNote = stride === 1 ? 'writes consecutive elements' : `writes every ${ordinal(stride)} element`;
  } else if (!region) {
    lastElement = exec - 1;
    regionNote = 'sequential: channel i reads element i';
  } else if ((m2 = /^<(\d+)>$/.exec(region))) {
    const stride = Number(m2[1]);
    if (!threeSource) fullRegion = `<${stride};1,0>`;
    lastElement = (exec - 1) * stride;
    regionNote = stride === 0 ? 'scalar: every channel reads element 0'
      : `stride ${stride}: channel i reads element ${stride}·i`;
  } else if ((m2 = /^<(\d+);(\d+),(\d+)>$/.exec(region))) {
    const [v, w, h] = [Number(m2[1]), Number(m2[2]), Number(m2[3])];
    lastElement = 0;
    for (let i = 0; i < exec; i++) lastElement = Math.max(lastElement, Math.floor(i / w) * v + (i % w) * h);
    regionNote = v === 0 && h === 0 ? 'scalar: every channel reads element 0'
      : `rows of ${w}, ${h} apart, rows ${v} apart: channel i reads element ⌊i/${w}⌋·${v} + (i mod ${w})·${h}`;
  } else if (region.startsWith('<VxH')) {
    regionNote = 'per-channel indirect: each channel takes its own address from consecutive `a0` words';
  } else {
    regionNote = 'three-source region';
  }
  if (register.startsWith('r[')) lastElement = undefined;

  const full = bare ? `${register}:${type}`
    : `${modifier}${register}.${subnr}${fullRegion}${swizzle ?? ''}:${type}`;
  return { full, type, regionNote, subnr, ...(lastElement === undefined ? {} : { lastElement }) };
}

const ordinal = (n: number) => (n === 2 ? '2nd' : n === 3 ? '3rd' : `${n}th`);

function span(first: number, bytes: number, nr: number, grfSize: number): string {
  const last = first + bytes - 1;
  const firstReg = nr + Math.floor(first / grfSize);
  const lastReg = nr + Math.floor(last / grfSize);
  if (firstReg !== lastReg) return `${code(`r${firstReg}`)}–${code(`r${lastReg}`)} (${plural(lastReg - firstReg + 1, 'register')}, ${bytes} bytes)`;
  if (first % grfSize === 0 && bytes === grfSize) return `all of ${code(`r${firstReg}`)} (${bytes} bytes)`;
  const a = first % grfSize;
  return `byte${bytes === 1 ? ` ${a}` : `s ${a}–${a + bytes - 1}`} of ${code(`r${firstReg}`)}`;
}

/** Which bytes of which registers the operand touches. */
function covers(s: Scope, operand: Operand, index: number, shape: Shape): string {
  const ref = operand.registers[0];
  if (!ref || ref.file !== 'r' || operand.text.includes('[')) return '';
  const registerBytes = grfSize(versionOf(s.inst, s.generation));
  const size = TYPES[shape.type]?.size ?? 4;

  if (s.inst.opcode.name === 'dpas') {
    // Sizes follow from the systolic depth and repeat count, not from the region.
    const dims = /^\.(\d+)x(\d+)$/.exec(s.inst.opcode.suffix);
    if (!dims) return '';
    const [depth, count, exec] = [Number(dims[1]), Number(dims[2]), s.inst.execSize ?? 1];
    const bytes = index <= 1 ? count * exec * size : index === 2 ? depth * exec * 4 : count * depth * 4;
    return span(shape.subnr * size, bytes, ref.nr, registerBytes);
  }
  if (shape.lastElement === undefined) return '';
  return span(shape.subnr * size, (shape.lastElement + 1) * size, ref.nr, registerBytes);
}

// ---------------------------------------------------------------------------
// Immediates

function halfToNumber(h: number): number {
  const sign = h & 0x8000 ? -1 : 1;
  const exponent = (h >> 10) & 0x1f;
  const fraction = h & 0x3ff;
  if (exponent === 0) return sign * 2 ** -14 * (fraction / 1024);
  if (exponent === 31) return fraction ? NaN : sign * Infinity;
  return sign * 2 ** (exponent - 15) * (1 + fraction / 1024);
}

function immediateNotes(s: Scope, operand: Operand): string[] {
  const m = /^(-?)(0x[0-9a-fA-F]+|\d+)(?::([a-z]+))?/.exec(operand.text);
  if (!m) return [];
  const type = m[3] ?? 'ud';
  const raw = BigInt(m[2]);
  const value = m[1] ? -raw : raw;
  const notes = [`${TYPES[type]?.name ?? type} immediate`];
  const view = new DataView(new ArrayBuffer(8));

  switch (type) {
    case 'f':
      view.setUint32(0, Number(raw));
      notes.push(`value ${view.getFloat32(0)} (the printed digits are the raw IEEE bits)`);
      break;
    case 'df':
      view.setBigUint64(0, raw);
      notes.push(`value ${view.getFloat64(0)} (the printed digits are the raw IEEE bits)`);
      break;
    case 'hf':
      notes.push(`value ${halfToNumber(Number(raw))} (the printed digits are the raw half-float bits)`);
      break;
    case 'v':
    case 'uv': {
      const nibbles = Array.from({ length: 8 }, (_, i) => Number((raw >> BigInt(4 * i)) & 0xfn));
      const values = type === 'v' ? nibbles.map((n) => (n > 7 ? n - 16 : n)) : nibbles;
      notes.push(`elements, lowest first: ${values.join(', ')}`);
      break;
    }
    case 'vf':
      notes.push(`bytes, lowest first: ${Array.from({ length: 4 }, (_, i) => `0x${((Number(raw) >> (8 * i)) & 0xff).toString(16).padStart(2, '0')}`).join(', ')}`);
      break;
    default:
      if (m[2].startsWith('0x')) {
        notes.push(`decimal ${value}`);
        if (type === 'ud' && raw >= 0x80000000n) notes.push(`as signed: ${raw - 0x100000000n}`);
      } else {
        notes.push(`hex 0x${BigInt.asUintN(8 * (TYPES[type]?.size ?? 4), value).toString(16)}`);
      }
  }

  // `mov (1) s0:uq 0x…:uq` loads the register list of a gather send.
  if ((type === 'uq' || type === 'q') && s.inst.operands[0]?.registers[0]?.file === 's') {
    const numbers = Array.from({ length: 8 }, (_, i) => Number((raw >> BigInt(8 * i)) & 0xffn));
    notes.push(`as a gather-send register list, lowest byte first: ${numbers.map((n) => `r${n}`).join(', ')}`);
  }
  return notes;
}

// ---------------------------------------------------------------------------
// Execution, scoreboard, flags

function execution(s: Scope): string[] {
  const { inst, text } = s;
  const out: string[] = [];
  if (inst.execSize !== undefined) {
    const first = inst.channelOffset ?? 0;
    out.push(`${plural(inst.execSize, 'channel')}${inst.channelOffset ? ` (channels ${first}–${first + inst.execSize - 1} of the thread)` : ''}`);
  }
  const prefix = inst.prefix ? text.slice(inst.prefix.start, inst.prefix.end) : '';
  if (inst.predicate) {
    const flag = text.slice(inst.predicate.span.start, inst.predicate.span.end);
    const group = /\.(any|all)\w*\)/.exec(prefix)?.[1];
    const which = group ? `${group === 'any' ? 'any' : 'all'} of the bits of ${code(flag)} over the group are set`
      : `its bit in ${code(flag)} is ${prefix.includes('~') ? 'clear' : 'set'}`;
    out.push(inst.noMask
      ? `NoMask and predicated: a channel runs when ${which}, whatever the execution mask`
      : `predicated: an active channel runs when ${which}`);
  } else {
    out.push(inst.noMask
      ? 'NoMask: runs on every channel regardless of the execution mask'
      : 'runs on the channels active in the current control flow');
  }
  const pipe = pipeOf(inst, s.generation);
  if (pipe === 'unordered') out.push('completes out of order, tracked by a scoreboard token');
  else if (pipe !== 'none') out.push(`${PIPES[pipe]} pipe`);
  if (inst.cmod) {
    const flag = inst.cmod.flag ? code(text.slice(inst.cmod.flag.span.start, inst.cmod.flag.span.end)) : 'the flag';
    const condition = CONDITIONS[inst.cmod.condition] ?? inst.cmod.condition;
    const compares = /^(?:cmp|cmpn|sel)$/.test(inst.opcode.name);
    const when = /^[=!<>]/.test(condition)
      ? (compares ? `src0 ${condition} src1` : `the result ${condition} 0`)
      : `the result ${condition}`;
    out.push(`conditional modifier: sets a channel's bit in ${flag} when ${code(when)}`);
  }
  return out;
}

const WAIT_LIMIT = 6;

function scoreboard(s: Scope): string[] {
  const { inst, shader } = s;
  const out: string[] = [];
  const dist = inst.swsbRegDist;
  if (dist) {
    const pipe = !dist.pipe ? 'in program order' : dist.pipe === 'A' ? 'in any pipe' : `in the ${PIPES[dist.pipe]} pipe`;
    let line = `${code(s.text.slice(dist.span.start, dist.span.end))}: waits until the instruction ${dist.distance} back ${pipe} has completed.`;
    const target = regDistTarget(shader, inst, s.generation);
    if (target) {
      line += ` By count that is ${lineRef(s, target.inst)}`;
      if (!target.plausible) {
        line += ', which writes nothing this instruction uses, so the count is probably off (the compiler may assign pipes differently)';
      } else if (target.acrossControlFlow) {
        line += ', counted in file order across a branch or label, which the hardware may not have followed';
      }
      line += '.';
    }
    out.push(line);
  }
  const token = inst.swsbToken;
  if (!token) return out;
  const name = code(s.text.slice(token.span.start, token.span.end));

  if (token.mode === 'set') {
    const waits: string[] = [];
    let more = 0;
    for (let i = inst.index + 1; i < shader.instructions.length; i++) {
      const t = shader.instructions[i].swsbToken;
      if (t?.id !== token.id) continue;
      if (t.mode === 'set') break;
      if (waits.length < WAIT_LIMIT) {
        waits.push(`  - ${lineRef(s, shader.instructions[i])}, for its ${t.mode === 'dst' ? 'result' : 'sources to be read'}`);
      } else {
        more++;
      }
    }
    out.push(`${name}: this instruction owns scoreboard token ${token.id} until the token is set again.`
      + (waits.length ? ' Waited on by:' : ' Nothing below waits on it before then.'));
    out.push(...waits);
    if (more) out.push(`  - and ${more} more`);
    return out;
  }

  let setter: Instruction | undefined;
  for (let i = inst.index - 1; i >= 0 && !setter; i--) {
    const t = shader.instructions[i].swsbToken;
    if (t?.id === token.id && t.mode === 'set') setter = shader.instructions[i];
  }
  const what = token.mode === 'dst'
    ? 'has written its destination, so the result can be read or overwritten'
    : 'has read its sources, so its payload registers can be overwritten';
  out.push(`${name}: waits until the owner of token ${token.id} ${what}.`
    + (setter ? ` Owner: ${lineRef(s, setter)}` : ' No owner above (set later in a loop).'));
  return out;
}

const flagNotes = (inst: Instruction) => inst.flags.map((f) => `${code(f.name)}: ${FLAGS[f.name] ?? 'unknown flag'}`);

// ---------------------------------------------------------------------------
// bfn

/** Evaluates a bfn expression over a, b, c. Operators as in C: ~ binds tightest, then &, ^, |. */
function truthTable(expression: string): number[] | undefined {
  const tokens = expression.match(/[abc01~&^|()]/g);
  if (!tokens || tokens.join('') !== expression.replace(/\s+/g, '')) return undefined;
  const rows: number[] = [];
  try {
    for (let input = 0; input < 8; input++) {
      const env: Record<string, number> = { a: (input >> 2) & 1, b: (input >> 1) & 1, c: input & 1, 0: 0, 1: 1 };
      let at = 0;
      const primary = (): number => {
        const t = tokens[at++];
        if (t === '~') return primary() ^ 1;
        if (t === '(') {
          const value = or();
          if (tokens[at++] !== ')') throw new Error('unbalanced');
          return value;
        }
        if (!(t in env)) throw new Error('unexpected');
        return env[t];
      };
      const and = (): number => {
        let value = primary();
        while (tokens[at] === '&') { at++; value &= primary(); }
        return value;
      };
      const xor = (): number => {
        let value = and();
        while (tokens[at] === '^') { at++; value ^= and(); }
        return value;
      };
      const or = (): number => {
        let value = xor();
        while (tokens[at] === '|') { at++; value |= xor(); }
        return value;
      };
      rows.push(or());
      if (at !== tokens.length) return undefined;
    }
  } catch {
    return undefined;
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Whole-instruction hovers

function rolesOf(inst: Instruction): string[] {
  const doc = OPCODES[inst.opcode.name];
  if (doc?.roles) return doc.roles;
  if (isBranch(inst.opcode.name)) return ['target', 'target'];
  const sources = ['source 0', 'source 1', 'source 2'];
  return hasDestination(inst.opcode.name) ? ['destination', ...sources] : sources;
}

function operandTable(s: Scope): string[] {
  const { inst } = s;
  if (!inst.operands.length) return [];
  const roles = rolesOf(inst);
  const dst = hasDestination(inst.opcode.name);
  const rows = inst.operands.map((operand, i) => {
    const role = roles[i] ?? `operand ${i}`;
    if (operand.kind === 'branch') {
      const target = operand.label && s.shader.labels.get(operand.label.name);
      const where = target ? `[line ${target.span.line + 1}](${s.link(target.span.line)})` : '';
      return `| ${role} | ${code(operand.text)} | ${where} | |`;
    }
    if (operand.kind === 'immediate') {
      return `| ${role} | ${code(operand.text)} | ${immediateNotes(s, operand).slice(1).join('; ')} | |`;
    }
    const shape = shapeOf(s, operand, dst && i === 0);
    if (!shape) return `| ${role} | ${code(operand.text)} | | ${origin(s, operand)} |`;
    const detail = [shape.full === operand.text ? '' : code(shape.full), covers(s, operand, i, shape)].filter(Boolean).join(', ');
    return `| ${role} | ${code(operand.text)} | ${detail} | ${origin(s, operand)} |`;
  });
  return ['| Role | Operand | In full | Last written |', '|---|---|---|---|', ...rows];
}

function sendSection(s: Scope): string[] | undefined {
  const info = analyzeSend(s.inst, s.text, s.generation);
  if (!info) return undefined;
  const registerBytes = grfSize(versionOf(s.inst, s.generation));
  const size = (grfs: number) => `${plural(grfs, 'register')} (${grfs * registerBytes} bytes)`;
  const out: string[] = [];
  const { lengths, message } = info;

  if (message && message.name !== '?') out.push(`**Message** ${code(message.name)}`, '');
  else if (info.printedName) out.push(`**Message** ${code(info.printedName)} (as printed; not decoded here)`, '');
  if (message && info.printedName && message.name !== info.printedName) {
    out.push(`The line's own comment says ${code(info.printedName)}. If that differs, the`
      + ' `intelEuAsm.generation` setting probably does not match the platform this dump came from.', '');
  }

  const rows: string[] = [];
  const response = info.dst.text === 'null' ? 'none' : code(info.dst.text);
  rows.push(`| Response | ${response} | ${lengths ? (lengths.responseLength ? size(lengths.responseLength) : 'nothing returned') : ''} | |`);

  let payload = lengths ? size(lengths.messageLength) : '';
  if (lengths?.headerPresent) payload += ', the first is a message header';
  const gather = /^r\[s0(?:\.(\d+))?\]$/.exec(info.src0.text);
  if (gather) {
    // A gather send takes its payload from the registers whose numbers are packed into s0.
    const ref = info.src0.registers[0];
    const loader = ref && lastWriter(s, ref);
    const list = loader && /0x([0-9a-fA-F]{1,16}):u?q/.exec(s.lines[loader.line])?.[1];
    if (list && lengths) {
      const value = BigInt(`0x${list}`);
      const numbers = Array.from({ length: lengths.messageLength }, (_, i) => `r${Number((value >> BigInt(8 * i)) & 0xffn)}`);
      payload += `; gathered from ${numbers.map(code).join(', ')}`;
    } else {
      payload += '; gathered from the registers listed in `s0`';
    }
  }
  rows.push(`| Payload | ${code(info.src0.text)} | ${payload} | ${origin(s, info.src0)} |`);

  if (info.src1) {
    const length = info.extendedLength === undefined ? 'length known only at run time'
      : info.extendedLength ? size(info.extendedLength) : 'unused';
    rows.push(`| Second payload | ${code(info.src1.text)} | ${length} | ${info.extendedLength ? origin(s, info.src1) : ''} |`);
  }
  rows.push(`| Extended descriptor | ${code(info.exDesc.text)} | | ${origin(s, info.exDesc)} |`);
  rows.push(`| Descriptor | ${code(info.desc.text)} | | ${origin(s, info.desc)} |`);
  out.push('| Role | Operand | Size | Last written |', '|---|---|---|---|', ...rows);

  if (message?.fields.length) {
    out.push('', '| Field | Setting |', '|---|---|', ...message.fields.map((f) => `| ${f.label} | ${f.value} |`));
  }
  return out;
}

function instructionHover(s: Scope): string {
  const { inst } = s;
  const { name, suffix } = inst.opcode;
  const doc = OPCODES[name];
  const out: string[] = [`**${code(name + suffix)}** ${doc?.summary ?? ''}`.trim()];

  const sub = suffix.replace(/^\./, '');
  if (name === 'math' && MATH_FUNCTIONS[sub]) out.push('', `Function ${code(sub)}: ${MATH_FUNCTIONS[sub]}.`);
  if (name === 'sync' && SYNC_FUNCTIONS[sub]) out.push('', SYNC_FUNCTIONS[sub]);
  if (suffix.includes('.sat')) out.push('', 'Saturating: the result is clamped to the destination type\'s range (0 to 1 for floats).');
  if (name === 'dpas') {
    const dims = /^\.(\d+)x(\d+)$/.exec(suffix);
    if (dims) out.push('', `Systolic depth ${dims[1]}, repeat count ${dims[2]}.`);
  }
  if (doc?.formula) out.push('', code(doc.formula));

  if (name === 'bfn') {
    const table = truthTable(suffix.slice(2, -1));
    if (table) {
      out.push('', '| a | b | c | result |', '|---|---|---|---|',
        ...table.map((value, input) => `| ${(input >> 2) & 1} | ${(input >> 1) & 1} | ${input & 1} | ${value} |`));
    }
  }

  const send = sendSection(s);
  const operands = send ?? operandTable(s);
  if (operands.length) out.push('', ...operands);

  out.push('', `**Execution** ${execution(s).join('; ')}.`);
  const board = scoreboard(s);
  if (board.length) out.push('', '**Scoreboard**', '', ...board.map((line) => (line.startsWith('  -') ? line : `- ${line}`)));
  const flags = flagNotes(inst);
  if (flags.length) out.push('', '**Flags**', '', ...flags.map((f) => `- ${f}`));
  if (inst.errors.length) out.push('', '**Validator errors**', '', ...inst.errors.map((e) => `- ${e.message}`));
  return out.join('\n');
}

function operandHover(s: Scope, operand: Operand, index: number): string {
  const { inst } = s;
  const role = rolesOf(inst)[index] ?? `operand ${index}`;
  const out: string[] = [`**${code(operand.text)}** ${role} of ${code(inst.opcode.name + inst.opcode.suffix)}`];

  if (operand.kind === 'immediate') {
    out.push('', ...immediateNotes(s, operand).map((n) => `- ${n}`));
  } else if (operand.kind === 'branch') {
    const target = operand.label && s.shader.labels.get(operand.label.name);
    if (target) out.push('', `Target: [line ${target.span.line + 1}](${s.link(target.span.line)})`);
  } else if (!analyzeSend(inst, s.text, s.generation)) {
    const shape = shapeOf(s, operand, hasDestination(inst.opcode.name) && index === 0);
    if (shape) {
      const where = covers(s, operand, index, shape);
      out.push('',
        `- In full: ${code(shape.full)}`,
        `- Type: ${TYPES[shape.type]?.name ?? shape.type}, ${plural(TYPES[shape.type]?.size ?? 4, 'byte')} per element`
          + (operand.type ? '' : ' (not printed; `:ud` is the default)'),
        `- Region: ${shape.regionNote}`,
        ...(where ? [`- Covers: ${where}`] : []));
      if (/^-/.test(operand.text)) out.push('- Negated');
      if (/^~/.test(operand.text)) out.push('- Bitwise inverted');
      if (operand.text.includes('(abs)')) out.push('- Absolute value taken');
    }
  }
  const from = origin(s, operand);
  if (from) out.push('', `Last written: ${from}`);
  return out.join('\n');
}

function labelHover(ctx: HoverContext, shader: Shader, name: string): string {
  const def = shader.labels.get(name);
  const users = shader.instructions.filter((i) => i.labels.some((l) => l.name === name));
  const out = [`**${code(name)}** ${def ? `label at [line ${def.span.line + 1}](${ctx.link(def.span.line)})` : 'label, not defined in this shader'}`];
  if (def && users.some((i) => i.opcode.name === 'while' && i.line > def.span.line)) out.push('', 'Head of a loop.');
  if (users.length) out.push('', 'Named by:', '', ...users.map((i) => `- ${lineRef(ctx, i)}`));
  return out.join('\n');
}

export function hoverAt(ctx: HoverContext, line: number, column: number): HoverResult | undefined {
  const shader = shaderAt(ctx.doc, line);
  if (!shader) return undefined;

  for (const label of shader.labels.values()) {
    if (label.span.line === line && inside(label.span, column)) {
      return { span: label.span, markdown: labelHover(ctx, shader, label.name) };
    }
  }

  const inst = ctx.doc.instructionAt[line];
  if (!inst) return undefined;
  const s: Scope = { ...ctx, shader, inst, text: ctx.lines[line] };
  const list = (items: string[]) => items.map((i) => (i.startsWith('  -') ? i : `- ${i}`)).join('\n');

  for (const item of [inst.swsbToken, inst.swsbRegDist]) {
    if (inside(item?.span, column)) return { span: item.span, markdown: list(scoreboard(s)) };
  }
  const flag = inst.flags.find((f) => inside(f.span, column));
  if (flag) return { span: flag.span, markdown: `${code(flag.name)}: ${FLAGS[flag.name] ?? 'unknown flag'}` };

  const index = inst.operands.findIndex((o) => inside(o.span, column));
  if (index >= 0) {
    const operand = inst.operands[index];
    if (inside(operand.label?.span, column)) {
      return { span: operand.label.span, markdown: labelHover(ctx, shader, operand.label.name) };
    }
    return { span: operand.span, markdown: operandHover(s, operand, index) };
  }

  for (const item of [inst.prefix, inst.exec, inst.cmod?.span]) {
    if (inside(item, column)) return { span: item, markdown: list(execution(s)) };
  }
  if (inside(inst.opcode.span, column)) return { span: inst.opcode.span, markdown: instructionHover(s) };
  return undefined;
}
