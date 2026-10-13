// Which in-order pipe an instruction runs in, and from that which earlier
// instruction a `P@N` annotation waits for. The classification follows
// inferred_exec_pipe() in Mesa's brw_lower_scoreboard.cpp, applied to the
// printed instruction instead of the IR.

import type { Instruction, Shader } from '../parser/model.ts';
import { hasDestination, isBranch } from '../parser/parse.ts';
import { versionOf, type Generation } from '../platform.ts';

/** `F` float, `I` integer, `L` long, `M` math, `S` scalar. */
export type Pipe = 'F' | 'I' | 'L' | 'M' | 'S';

/**
 * `unordered`: completes out of order and is tracked by a token instead.
 * `none`: takes no part in the scoreboard's instruction count.
 */
export type PipeClass = Pipe | 'unordered' | 'none';

const SIZES: Record<string, number> = {
  ub: 1, b: 1, uw: 2, w: 2, hf: 2, bf: 2, ud: 4, d: 4, f: 4, uq: 8, q: 8, df: 8, v: 4, uv: 4, vf: 4,
};
const FLOAT = /^(?:hf|bf|f|df)$/;
const UNORDERED = /^(?:send[a-z]*|dpas|load\w*|store\w*|atomic\w*|fence)$/;

export function pipeOf(inst: Instruction, assumed: Generation): PipeClass {
  const version = versionOf(inst, assumed);
  const name = inst.opcode.name;
  if (name === 'sync' || name === 'nop' || name === 'illegal') return 'none';
  if (UNORDERED.test(name) || (name === 'math' && version < 200)) return 'unordered';
  // Before Xe-HPG there is a single pipe, which Mesa calls float.
  if (version < 125) return 'F';

  const dst = hasDestination(name) ? inst.operands[0] : undefined;
  const sources = inst.operands.slice(dst ? 1 : 0);
  const dstType = (!isBranch(name) && dst?.type) || 'ud';
  const type = (i: number) => sources[i]?.type ?? 'ud';

  if (version >= 300 && inst.execSize === 1 && dst?.registers[0]?.file === 's' && sources[0]?.kind === 'immediate') return 'S';
  if (name === 'math') return 'M';
  if (version >= 350 && (name === 'mov' || name === 'srnd') && dstType !== type(0)
      && SIZES[dstType] <= 4 && FLOAT.test(dstType)) return 'I';

  if (version >= 200) {
    if (dstType === 'df') return 'L';
  } else {
    // The long pipe also takes anything 64-bit wide and dword-by-dword integer multiplies.
    const execSize = Math.max(...sources.map((_, i) => SIZES[type(i)] ?? 4), 0);
    const integer = !sources.some((_, i) => FLOAT.test(type(i)));
    const dwordMultiply = integer && (
      (name === 'mul' && Math.min(SIZES[type(0)], SIZES[type(1)]) >= 4)
      || (name === 'mad' && Math.min(SIZES[type(1)], SIZES[type(2)]) >= 4));
    if (SIZES[dstType] >= 8 || execSize >= 8 || dwordMultiply) return 'L';
  }
  return FLOAT.test(dstType) ? 'F' : 'I';
}

export interface RegDistTarget {
  inst: Instruction;
  /**
   * Whether the target writes a register this instruction names, or one
   * within a few numbers of it (a wide operand names only its first
   * register). When false the count has probably landed on the wrong
   * instruction: a compiler's idea of the pipes can differ from these rules.
   */
  plausible: boolean;
  /**
   * True when a label or branch lies between the two instructions. The count
   * was made in text order, which is then only one of the orders the hardware
   * may have executed them in.
   */
  acrossControlFlow: boolean;
}

// Wide operands (SIMD32 values, dpas matrices, send payloads) cover the registers after the one they name.
const SPAN = 8;
const IMPLICIT_ACC = /^(?:mul|mac|mach|macl|addc|subb)$/;

function depends(shader: Shader, inst: Instruction, writer: Instruction): boolean {
  // A sync carries the wait for the instruction after it.
  let user = inst;
  while (user.opcode.name === 'sync' && shader.instructions[user.index + 1]) user = shader.instructions[user.index + 1];
  if (IMPLICIT_ACC.test(writer.opcode.name) && IMPLICIT_ACC.test(user.opcode.name)) return true;
  return writer.registers.some((w) => w.access === 'write' && w.file !== 'null' && user.registers.some((r) =>
    r.file === w.file && (r.file === 'r' ? Math.abs(r.nr - w.nr) < SPAN : r.nr === w.nr)));
}

/** The instruction a `P@N` annotation on `inst` waits for, counting back in text order. */
export function regDistTarget(shader: Shader, inst: Instruction, assumed: Generation): RegDistTarget | undefined {
  const dist = inst.swsbRegDist;
  if (!dist || dist.distance < 1) return undefined;
  let remaining = dist.distance;
  let acrossControlFlow = false;
  let below = inst.line;

  for (let i = inst.index - 1; i >= 0; i--) {
    const candidate = shader.instructions[i];
    for (const label of shader.labels.values()) {
      if (label.span.line > candidate.line && label.span.line < below) acrossControlFlow = true;
    }
    below = candidate.line;
    const pipe = pipeOf(candidate, assumed);
    if (pipe !== 'none' && pipe !== 'unordered' && (!dist.pipe || dist.pipe === 'A' || dist.pipe === pipe)) {
      if (--remaining === 0) return { inst: candidate, acrossControlFlow, plausible: depends(shader, inst, candidate) };
    }
    if (isBranch(candidate.opcode.name)) acrossControlFlow = true;
  }
  return undefined;
}
