// Bridge to Mesa's `gentool`: assemble, disassemble and region diagrams.
// Uses only Node's process API, so it can be tested without an editor.

import { execFile } from 'node:child_process';
import type { ParsedDocument, Shader } from '../parser/model.ts';
import { parseDocument } from '../parser/parse.ts';
import type { Generation } from '../platform.ts';

/** The gentool platform to use for each generation when none is configured. */
export const DEFAULT_PLATFORM: Record<Generation, string> = {
  xe3p: 'nvl', xe3: 'ptl', xe2: 'bmg', 'xe-hpg': 'mtl', 'xe-lp': 'tgl',
};

export interface Gentool {
  /** Path to the gentool binary. */
  path: string;
  /** gentool's platform name, e.g. `nvl`. */
  platform: string;
}

export class GentoolError extends Error {
  /** `missing`: the binary could not be run. `failed`: it ran and reported a problem. */
  kind: 'missing' | 'failed';

  constructor(kind: 'missing' | 'failed', message: string) {
    super(message);
    this.kind = kind;
  }
}

interface RunResult {
  ok: boolean;
  stdout: Buffer;
  /** stderr without the driver's own log lines. */
  stderr: string;
}

const TIMEOUT_MS = 20000;
const MAX_OUTPUT = 256 * 1024 * 1024;

function run(tool: Gentool, args: string[], input: string | Buffer): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      tool.path, [args[0], '-p', tool.platform, ...args.slice(1)],
      { encoding: 'buffer', timeout: TIMEOUT_MS, maxBuffer: MAX_OUTPUT },
      (error, stdout, stderrRaw) => {
        // Mesa logs device warnings such as "requires INTEL_FORCE_PROBE" on stderr; they are not about the input.
        const stderr = stderrRaw.toString().split('\n').filter((l) => !l.startsWith('MESA:')).join('\n').trim();
        if (error && typeof error.code === 'string') {
          const why = error.code === 'ENOENT' ? 'file not found' : error.code === 'EACCES' ? 'not executable' : error.code;
          reject(new GentoolError('missing', `Cannot run gentool at "${tool.path}": ${why}.`));
        } else if (error?.killed) {
          reject(new GentoolError('failed', `gentool did not finish within ${TIMEOUT_MS / 1000} seconds.`));
        } else {
          resolve({ ok: !error, stdout, stderr });
        }
      });
    // gentool may exit before reading everything, e.g. on an unknown platform.
    child.stdin?.on('error', () => {});
    child.stdin?.end(input);
  });
}

/** A problem gentool reported, located on a line of the original document. */
export interface AssemblyError {
  line: number;
  message: string;
}

export interface Assembly {
  /** Encoded instructions; absent when there were errors. */
  binary?: Buffer;
  errors: AssemblyError[];
}

/**
 * The text of one shader in the form `gentool asm` accepts. A dump is not
 * quite that: headers, statistics and comments are not assembly, and
 * `Compacted` describes the encoding the printer saw, not something to ask
 * for. Every line keeps its position, so gentool's line numbers count from
 * the shader's first line.
 */
export function prepareForAssembly(lines: readonly string[], doc: ParsedDocument, shader: Shader): string {
  const out: string[] = [];
  for (let line = shader.startLine; line <= shader.endLine; line++) {
    const text = lines[line];
    const inst = doc.instructionAt[line];
    if (inst) {
      const body = text.slice(inst.column0, inst.comment?.start ?? text.length);
      out.push(body.replace(/\{([^}]*)\}/, (_, options: string) => {
        const kept = options.split(',').filter((o) => o !== 'Compacted');
        return kept.length ? `{${kept.join(',')}}` : '';
      }).trimEnd());
    } else {
      out.push(doc.kinds[line] === 'label' ? text.replace(/\/\/.*$/, '').trimEnd() : '');
    }
  }
  return out.join('\n') + '\n';
}

/**
 * Reads gentool's two error formats. Parse errors are `<file>:<line>: message`.
 * Validation errors come as a listing of the whole program with `ERROR:`
 * lines under the offending instructions, so they are matched up by counting
 * instructions.
 */
export function parseErrors(stderr: string, shader: Shader): AssemblyError[] {
  const errors: AssemblyError[] = [];
  let index = -1;
  for (const text of stderr.split('\n')) {
    let m;
    if ((m = /^.*?:(\d+): (.*)$/.exec(text))) {
      errors.push({ line: shader.startLine + Number(m[1]) - 1, message: m[2] });
    } else if ((m = /^\s*ERROR: (.*)$/.exec(text))) {
      const inst = shader.instructions[Math.max(index, 0)];
      errors.push({ line: inst?.line ?? shader.startLine, message: m[1] });
    } else if (text.trim() && !/^L\d+:/.test(text) && !/^gentool \w+:/.test(text)) {
      index++;
    }
  }
  if (!errors.length && stderr) errors.push({ line: shader.startLine, message: stderr.split('\n')[0] });
  return errors;
}

export async function assemble(
  tool: Gentool, lines: readonly string[], doc: ParsedDocument, shader: Shader,
): Promise<Assembly> {
  const result = await run(tool, ['asm', '-i', '-', '-o', '-'], prepareForAssembly(lines, doc, shader));
  if (result.ok) return { binary: result.stdout, errors: [] };
  // A complaint about the platform or options is not about any line of the input.
  if (/^ERROR:/.test(result.stderr)) throw new GentoolError('failed', result.stderr.replace(/^ERROR:\s*/, ''));
  return { errors: parseErrors(result.stderr, shader) };
}

export interface DisassemblyOptions {
  /** Print explicit regions, types and sub-registers. */
  verbose?: boolean;
  /** Print LSC sends as `load.ugm…` mnemonics instead of raw sends. */
  translatedSends?: boolean;
  /** Prefix each instruction with its encoded bytes. */
  hex?: boolean;
}

export async function disassemble(tool: Gentool, binary: Buffer, options: DisassemblyOptions = {}): Promise<string> {
  const flags = [
    ...(options.verbose ? ['-v'] : []),
    ...(options.translatedSends ? ['--translated-sends'] : []),
    ...(options.hex ? ['--hex'] : []),
  ];
  const result = await run(tool, ['disasm', ...flags, '-i', '-', '-o', '-'], binary);
  if (!result.ok) throw new GentoolError('failed', result.stderr.replace(/^ERROR:\s*/, '') || 'gentool disasm failed.');
  return result.stdout.toString();
}

/**
 * Lays a re-disassembled shader over the lines of the original: each
 * instruction line is replaced by gentool's print of the same instruction, and
 * every other line (header, comments, labels, blanks) stays where it is. The
 * result has the original's line count, so the two can be read side by side
 * and scrolled together.
 *
 * Returns the replacement for lines `startLine..endLine` of the shader, or
 * undefined when the disassembly does not correspond instruction for
 * instruction.
 */
export function overlayDisassembly(
  lines: readonly string[], shader: Shader, disassembly: string,
): string[] | undefined {
  const printedLines = disassembly.split('\n');
  const [printed] = parseDocument(printedLines).shaders;
  if (!printed || printed.instructions.length !== shader.instructions.length) return undefined;

  // gentool numbers labels itself, in address order. Carry the original's names over.
  const inOrder = (s: Shader) => [...s.labels.values()].sort((a, b) => a.span.line - b.span.line).map((l) => l.name);
  const theirs = inOrder(printed);
  const ours = inOrder(shader);
  if (theirs.length !== ours.length) return undefined;
  const rename = new Map(theirs.map((name, i) => [name, ours[i]]));

  const out = lines.slice(shader.startLine, shader.endLine + 1);
  shader.instructions.forEach((inst, i) => {
    const theirInst = printed.instructions[i];
    let text = printedLines[theirInst.line].trimEnd();
    // Rename from the right so earlier spans stay valid.
    for (const label of [...theirInst.labels].reverse()) {
      text = text.slice(0, label.span.start) + (rename.get(label.name) ?? label.name) + text.slice(label.span.end);
    }
    out[inst.line - shader.startLine] = text;
  });
  return out;
}

/**
 * gentool's diagram of the register bytes one instruction touches, or
 * undefined when it cannot draw one (branches, some addressing modes).
 */
export async function regionDiagram(tool: Gentool, instruction: string): Promise<string | undefined> {
  const result = await run(tool, ['region'], instruction + '\n');
  const text = result.stdout.toString().trimEnd();
  return result.ok && text ? text : undefined;
}

/** One instruction line reduced to what `gentool region` accepts. */
export function instructionText(lines: readonly string[], doc: ParsedDocument, line: number): string | undefined {
  const inst = doc.instructionAt[line];
  if (!inst) return undefined;
  const shader: Shader = { name: '', startLine: line, endLine: line, instructions: [inst], labels: new Map() };
  return prepareForAssembly(lines, doc, shader).trim();
}
