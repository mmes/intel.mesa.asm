// Line-oriented parser for Mesa's EU assembly dumps. The syntax is the one
// gen_print.cpp emits; see docs/dump-format.md.

import type {
  Instruction, LineKind, Operand, ParsedDocument, RegisterFile, RegisterRef, Shader, Span,
} from './model.ts';

const HEADER = /^Native code for (.*)$/;
const STATS = /^(?:[A-Z]+ )?(SIMD\d+) shader: (\d+) inst(?:ructions)?\b/;
const LABEL = /^(L\d+):\s*(?:\/\/.*)?$/;
const COMMENT = /^\s*\/\//;
const ERROR = /^\s*ERROR: (.*)$/;

// Prefixes that may precede an instruction: a round-trip case
// (`tgl | 40 00 … |`) or the bytes INTEL_DEBUG=hex prints.
const CASE_PREFIX = /^([a-z][a-z0-9]{2}) \| (?:[0-9a-f]{2} )+[|<>] /;
const HEX_PREFIX = /^(?:[0-9a-f]{2} ){8,16}/;
// The printer pads the bytes of a compacted instruction to the width of a full one.
const HEX_PREFIX_WIDTH = 48;

const PREDICATE = /\((W)?&?~?(?:(f\d\.\d)(?:\.[a-z0-9]+)?)?\)/y;
const OPCODE = /(nop)(?=\s*(?:\{|\/\/|$))|(bfn)(\.\([^)]*\))|([a-z][a-z0-9_]*)((?:\.[a-z0-9_]+|\[[^\]]*\])*)/y;
const EXEC = /\s+\((\d+)(?:\|M(\d+))?\)/y;
const CMOD = /\s+\((eq|ne|gt|ge|lt|le|ov|un)\)(f\d\.\d)?/y;
const OPTIONS = /\{([^}]*)\}\s*$/;

const REGISTER =
  /(?<![\w.])(?:(r)(\d+)(?:\.(\d+))?|(acc|mask|sr|cr|tm|tdr|a|f|s|n)(\d+)(?:\.(\d+))?|(null|ip|tdr))(?![\w\[])/g;

const TYPE = '(?:ub|uw|ud|uq|uv|hf|bf|df|vf|b|w|d|q|f|v)';
const NUMBER = '-?(?:0x[0-9a-fA-F]+|\\d+)';
const OPERAND_BRANCH = new RegExp(`^(?:(?:jip|uip):)?(?:(L\\d+)|${NUMBER})$`);
const OPERAND_REGISTER = new RegExp(
  `^[-~]?(?:\\(abs\\))?(?:r\\[[^\\]]*\\]|[a-z]+\\d*(?:\\.\\d+)?)(<[^>]*>)?(?:\\.(?:[xyzw]{1,4}|r))?(?::(${TYPE}|\\d+))?$`);
const OPERAND_IMMEDIATE = new RegExp(`^${NUMBER}(?::(${TYPE}))?(?::a\\d+\\.\\d+)?$`);
const OPERAND_MEMORY = /^\[.*\]$/;

// The branch1 and branch2 opcodes of gen_opcodes.py.
const BRANCH = /^(?:if|else|endif|while|break|continue|halt|join|jmpi|goto|call|calla|ret|brd|brc)$/;
const NO_DST = /^(?:sync|nop|illegal|smov)$/;

/** True for control-flow opcodes, whose operands are jump targets. */
export const isBranch = (name: string) => BRANCH.test(name);

/**
 * True when the first operand is a destination. The exceptions are
 * gen_opcodes.py's NO_DST set and the store forms of translated sends.
 */
export const hasDestination = (name: string) =>
  !BRANCH.test(name) && !NO_DST.test(name) && !name.startsWith('store');

function registersIn(text: string, line: number, offset: number, access: 'read' | 'write'): RegisterRef[] {
  const refs: RegisterRef[] = [];
  REGISTER.lastIndex = 0;
  for (let m; (m = REGISTER.exec(text)); ) {
    const file = (m[1] ?? m[4] ?? m[7]) as RegisterFile;
    const nr = m[2] ?? m[5];
    const subnr = m[3] ?? m[6];
    refs.push({
      span: { line, start: offset + m.index, end: offset + m.index + m[0].length },
      file,
      nr: nr === undefined ? 0 : Number(nr),
      ...(subnr === undefined ? {} : { subnr: Number(subnr) }),
      access,
    });
  }
  return refs;
}

function parseOperand(text: string, line: number, start: number, isDst: boolean): Operand {
  const span: Span = { line, start, end: start + text.length };
  const operand: Operand = { span, text, kind: 'unknown', registers: [] };
  let m;

  if ((m = OPERAND_BRANCH.exec(text)) && (m[1] || text.includes(':'))) {
    operand.kind = 'branch';
    if (m[1]) {
      const at = start + text.length - m[1].length;
      operand.label = { span: { line, start: at, end: at + m[1].length }, name: m[1] };
    }
    return operand;
  }
  if ((m = OPERAND_IMMEDIATE.exec(text))) {
    operand.kind = 'immediate';
    if (m[1]) operand.type = m[1];
    // `0x00080000:a0.2`: the extended descriptor also reads an address register.
    operand.registers = registersIn(text, line, start, 'read');
    return operand;
  }
  if (OPERAND_MEMORY.test(text)) {
    operand.kind = 'memory';
    operand.registers = registersIn(text, line, start, 'read');
    return operand;
  }
  if ((m = OPERAND_REGISTER.exec(text))) {
    // A register reached through `r[a0.0]` is not named on the line, so only a
    // directly named destination counts as a write.
    const direct = !text.includes('[');
    operand.registers = registersIn(text, line, start, isDst && direct ? 'write' : 'read');
    if (operand.registers.length || !direct) {
      operand.kind = 'register';
      if (m[1]) operand.region = m[1];
      if (m[2] && !/^\d/.test(m[2])) operand.type = m[2];
    }
  }
  return operand;
}

// Splits on whitespace outside square brackets, so `r[a0.0 + 32]` and
// `[r80:1 + (4, 4)]` stay whole.
function splitOperands(text: string, offset: number): { text: string; start: number }[] {
  const parts: { text: string; start: number }[] = [];
  let depth = 0;
  let begin = -1;
  for (let i = 0; i <= text.length; i++) {
    const c = i < text.length ? text[i] : ' ';
    if (c === '[') depth++;
    else if (c === ']') depth--;
    const space = (c === ' ' || c === '\t') && depth <= 0;
    if (!space && begin < 0) begin = i;
    if (space && begin >= 0) {
      parts.push({ text: text.slice(begin, i), start: offset + begin });
      begin = -1;
    }
  }
  return parts;
}

/** Parses one line as an instruction, or returns undefined if it does not have the shape of one. */
export function parseInstruction(text: string, line: number): Instruction | undefined {
  const casePrefix = CASE_PREFIX.exec(text);
  let pos = casePrefix?.[0].length ?? (HEX_PREFIX.test(text) ? HEX_PREFIX_WIDTH : 0);
  const column0 = pos;
  const skipSpace = () => {
    while (text[pos] === ' ' || text[pos] === '\t') pos++;
  };
  const registers: RegisterRef[] = [];
  let ok = true;
  let m;

  skipSpace();
  let noMask = false;
  let predicate: RegisterRef | undefined;
  let prefix: Span | undefined;
  PREDICATE.lastIndex = pos;
  if ((m = PREDICATE.exec(text)) && (m[1] || m[2])) {
    noMask = !!m[1];
    prefix = { line, start: pos, end: pos + m[0].length };
    if (m[2]) {
      [predicate] = registersIn(m[2], line, pos + m[0].indexOf(m[2]), 'read');
      registers.push(predicate);
    }
    pos += m[0].length;
    skipSpace();
  }

  OPCODE.lastIndex = pos;
  if (!(m = OPCODE.exec(text))) return undefined;
  const name = m[1] ?? m[2] ?? m[4];
  const suffix = m[3] ?? m[5] ?? '';
  const opcode = { span: { line, start: pos, end: pos + m[0].length }, name, suffix };
  pos += m[0].length;

  let execSize: number | undefined;
  let channelOffset: number | undefined;
  let exec: Span | undefined;
  EXEC.lastIndex = pos;
  if ((m = EXEC.exec(text))) {
    exec = { line, start: pos + m[0].indexOf('('), end: pos + m[0].length };
    execSize = Number(m[1]);
    if (m[2] !== undefined) channelOffset = Number(m[2]);
    pos += m[0].length;
  } else if (name !== 'nop') {
    return undefined;
  }

  let cmod: Instruction['cmod'];
  CMOD.lastIndex = pos;
  if ((m = CMOD.exec(text))) {
    const start = pos + m[0].indexOf('(');
    cmod = { span: { line, start, end: pos + m[0].length }, condition: m[1] };
    if (m[2]) {
      [cmod.flag] = registersIn(m[2], line, pos + m[0].length - m[2].length, 'write');
      registers.push(cmod.flag);
    }
    pos += m[0].length;
  }

  let body = text.slice(pos);
  let comment: Span | undefined;
  const slashes = body.indexOf('//');
  if (slashes >= 0) {
    comment = { line, start: pos + slashes, end: text.length };
    body = body.slice(0, slashes);
  }

  const inst: Instruction = {
    line, index: 0, column0, opcode, noMask, operands: [], flags: [], registers, labels: [], errors: [], ok: true,
    ...(casePrefix ? { platform: casePrefix[1] } : {}),
    ...(prefix ? { prefix } : {}),
    ...(exec ? { exec } : {}),
    ...(execSize === undefined ? {} : { execSize }),
    ...(channelOffset === undefined ? {} : { channelOffset }),
    ...(predicate ? { predicate } : {}),
    ...(cmod ? { cmod } : {}),
    ...(comment ? { comment } : {}),
  };

  if ((m = OPTIONS.exec(body))) {
    let at = pos + m.index + 1;
    inst.options = { line, start: pos + m.index, end: pos + m.index + m[1].length + 2 };
    for (const item of m[1].split(',')) {
      const span = { line, start: at, end: at + item.length };
      at += item.length + 1;
      let o;
      if ((o = /^\$(\d+)(?:\.(dst|src))?$/.exec(item))) {
        inst.swsbToken ??= { span, id: Number(o[1]), mode: (o[2] as 'dst' | 'src' | undefined) ?? 'set' };
      } else if ((o = /^([FILMSA]?)@(\d+)$/.exec(item))) {
        inst.swsbRegDist ??= { span, pipe: o[1], distance: Number(o[2]) };
      } else if (/^[A-Za-z][A-Za-z0-9]*$/.test(item)) {
        inst.flags.push({ span, name: item });
      } else {
        ok = false;
      }
    }
    body = body.slice(0, m.index);
  }

  const hasDst = hasDestination(name);
  splitOperands(body, pos).forEach((part, i) => {
    const operand = parseOperand(part.text, line, part.start, hasDst && i === 0);
    if (operand.kind === 'unknown') ok = false;
    inst.operands.push(operand);
    registers.push(...operand.registers);
    if (operand.label) inst.labels.push(operand.label);
  });

  inst.ok = ok;
  return inst;
}

function classify(text: string): LineKind {
  if (HEADER.test(text)) return 'header';
  if (STATS.test(text)) return 'stats';
  if (LABEL.test(text)) return 'label';
  if (COMMENT.test(text)) return 'comment';
  if (ERROR.test(text)) return 'error';
  return 'other';
}

export function parseDocument(lines: readonly string[]): ParsedDocument {
  const shaders: Shader[] = [];
  const kinds: LineKind[] = new Array(lines.length);
  const instructionAt: (Instruction | undefined)[] = new Array(lines.length);
  let shader: Shader | undefined;

  // A listing with no header (gentool output, a case file) still gets a
  // shader, so labels and registers have a scope.
  const current = (line: number): Shader => {
    if (!shader) {
      shader = { name: '(listing)', startLine: line, endLine: line, instructions: [], labels: new Map() };
      shaders.push(shader);
    }
    return shader;
  };

  for (let line = 0; line < lines.length; line++) {
    const text = lines[line];
    let kind = classify(text);
    let inst: Instruction | undefined;
    if (kind === 'other' && text.length && (inst = parseInstruction(text, line))) kind = 'instruction';
    kinds[line] = kind;

    switch (kind) {
      case 'header':
        shader = {
          name: HEADER.exec(text)![1].trim(),
          headerLine: line, startLine: line, endLine: line, instructions: [], labels: new Map(),
        };
        shaders.push(shader);
        continue;
      case 'instruction': {
        const s = current(line);
        inst!.index = s.instructions.length;
        s.instructions.push(inst!);
        instructionAt[line] = inst;
        break;
      }
      case 'label': {
        const name = LABEL.exec(text)![1];
        current(line).labels.set(name, { span: { line, start: 0, end: name.length }, name });
        break;
      }
      case 'stats': {
        const m = STATS.exec(text);
        if (shader && m) shader.summary ??= `${m[1]}, ${m[2]} instructions`;
        break;
      }
      case 'error': {
        // The printer writes errors directly under the instruction they are about.
        const last = shader?.instructions.at(-1);
        last?.errors.push({ line, message: ERROR.exec(text)![1] });
        break;
      }
      case 'comment':
        break;
      default:
        continue;
    }
    if (shader) shader.endLine = line;
  }

  return { shaders, kinds, instructionAt };
}

export function shaderAt(doc: ParsedDocument, line: number): Shader | undefined {
  return doc.shaders.find((s) => line >= s.startLine && line <= s.endLine);
}
