import type { Instruction, ParsedDocument, RegisterRef, Shader, Span } from '../parser/model.ts';
import { shaderAt } from '../parser/parse.ts';
import type { Generation } from '../platform.ts';
import { regDistTarget } from './pipes.ts';

/** What the cursor is on. */
export type Target =
  | { kind: 'label'; shader: Shader; name: string }
  | { kind: 'register'; shader: Shader; ref: RegisterRef }
  | { kind: 'swsb'; shader: Shader; id: number }
  /** The cursor is on an opcode: stands for every register that instruction's operands name. */
  | { kind: 'instruction'; shader: Shader; inst: Instruction };

export interface Occurrence {
  span: Span;
  /** `write` marks a definition: a label's own line, a written register, the instruction that sets a token. */
  access: 'read' | 'write';
}

const contains = (span: Span, column: number) => column >= span.start && column <= span.end;

export function targetAt(doc: ParsedDocument, line: number, column: number): Target | undefined {
  const shader = shaderAt(doc, line);
  if (!shader) return undefined;

  for (const label of shader.labels.values()) {
    if (label.span.line === line && contains(label.span, column)) return { kind: 'label', shader, name: label.name };
  }

  const inst = doc.instructionAt[line];
  if (!inst) return undefined;
  const label = inst.labels.find((l) => contains(l.span, column));
  if (label) return { kind: 'label', shader, name: label.name };
  if (inst.swsbToken && contains(inst.swsbToken.span, column)) return { kind: 'swsb', shader, id: inst.swsbToken.id };
  const ref = inst.registers.find((r) => contains(r.span, column));
  if (ref && ref.file !== 'null') return { kind: 'register', shader, ref };
  const opcodeEnd = inst.exec?.end ?? inst.opcode.span.end;
  if (column >= inst.opcode.span.start && column <= opcodeEnd) return { kind: 'instruction', shader, inst };
  return undefined;
}

// Sub-registers of a GRF overlap in ways that depend on type and region, so
// any use of the same register number counts. Flag sub-registers are separate
// predicates and are matched exactly.
export function sameRegister(a: RegisterRef, b: RegisterRef): boolean {
  if (a.file !== b.file || a.nr !== b.nr) return false;
  return a.file !== 'f' || a.subnr === b.subnr;
}

/**
 * Where the thing under the cursor was defined: a label's own line, the last
 * write to a register above the cursor, the instruction that set a scoreboard
 * token, or the instruction a `P@N` annotation waits for. "Above" is in text
 * order, so a value produced later in a loop body and carried round the back
 * edge is not found.
 */
export function definitionAt(
  doc: ParsedDocument, line: number, column: number, generation: Generation = 'xe3',
): Span | undefined {
  const inst = doc.instructionAt[line];
  if (inst?.swsbRegDist && contains(inst.swsbRegDist.span, column)) {
    const shader = shaderAt(doc, line);
    return shader && regDistTarget(shader, inst, generation)?.inst.opcode.span;
  }
  const target = targetAt(doc, line, column);
  if (!target) return undefined;
  const all = occurrences(target);
  if (target.kind === 'label') return all.find((o) => o.access === 'write')?.span;
  if (target.kind === 'instruction') return undefined;

  const here = all.find((o) => o.span.line === line && contains(o.span, column));
  if (here?.access === 'write') return here.span;
  return all.findLast((o) => o.access === 'write' && o.span.line < line)?.span;
}

/** Every occurrence of the target within its shader, in line order. */
export function occurrences(target: Target): Occurrence[] {
  const { shader } = target;
  const found: Occurrence[] = [];

  switch (target.kind) {
    case 'label': {
      const def = shader.labels.get(target.name);
      if (def) found.push({ span: def.span, access: 'write' });
      for (const inst of shader.instructions) {
        for (const l of inst.labels) if (l.name === target.name) found.push({ span: l.span, access: 'read' });
      }
      break;
    }
    case 'register':
      for (const inst of shader.instructions) {
        for (const r of inst.registers) {
          if (sameRegister(r, target.ref)) found.push({ span: r.span, access: r.access });
        }
      }
      break;
    case 'swsb':
      for (const inst of shader.instructions) {
        const t = inst.swsbToken;
        if (t?.id === target.id) found.push({ span: t.span, access: t.mode === 'set' ? 'write' : 'read' });
      }
      break;
    case 'instruction': {
      // Operands only: the flags an instruction is predicated on or writes are
      // shared by too much of a shader to be worth lighting up with them.
      const wanted = target.inst.operands.flatMap((o) => o.registers).filter((r) => r.file !== 'null');
      for (const inst of shader.instructions) {
        for (const r of inst.registers) {
          if (wanted.some((w) => sameRegister(w, r))) found.push({ span: r.span, access: r.access });
        }
      }
      break;
    }
  }
  return found.sort((a, b) => a.span.line - b.span.line || a.span.start - b.span.start);
}
