// The document model: what the parser produces and every feature consumes.
// Nothing here or in the parser may import 'vscode'.

/** A span on one line. `end` is exclusive. */
export interface Span {
  line: number;
  start: number;
  end: number;
}

export type LineKind = 'header' | 'stats' | 'label' | 'comment' | 'error' | 'instruction' | 'other';

export type RegisterFile =
  | 'r' | 'null' | 'a' | 'acc' | 'f' | 'mask' | 's' | 'sr' | 'cr' | 'n' | 'tm' | 'tdr' | 'ip';

/** One occurrence of a register name, e.g. `r8.2`, `f0.0`, or the `a0.0` inside `r[a0.0]`. */
export interface RegisterRef {
  span: Span;
  file: RegisterFile;
  /** Register number; 0 for files that have no number. */
  nr: number;
  subnr?: number;
  access: 'read' | 'write';
}

export interface LabelRef {
  span: Span;
  name: string;
}

export type OperandKind = 'register' | 'immediate' | 'branch' | 'memory' | 'unknown';

export interface Operand {
  span: Span;
  text: string;
  kind: OperandKind;
  /** Type suffix without the colon; absent when the printer omitted it. */
  type?: string;
  /** Region or destination stride including the angle brackets. */
  region?: string;
  registers: RegisterRef[];
  label?: LabelRef;
}

export type SwsbMode = 'set' | 'dst' | 'src';

/** A `$N`, `$N.dst` or `$N.src` annotation. */
export interface SwsbToken {
  span: Span;
  id: number;
  mode: SwsbMode;
}

/** A `P@N` annotation; `pipe` is empty on platforms with a single pipe. */
export interface SwsbRegDist {
  span: Span;
  pipe: string;
  distance: number;
}

export interface Opcode {
  span: Span;
  /** Mnemonic up to the first dot: `send`, `add`, `load_block2d`. */
  name: string;
  /** Everything after the mnemonic, including the leading dot. */
  suffix: string;
}

export interface Instruction {
  line: number;
  /** Position among the shader's instructions, counted from 0. */
  index: number;
  /** Column where the instruction starts, after any platform or byte prefix. */
  column0: number;
  /** Platform named by a round-trip case line, e.g. `bmg`. Dumps do not record one. */
  platform?: string;
  /** The whole `(W&~f0.0)` prefix. */
  prefix?: Span;
  opcode: Opcode;
  /** The `(16|M16)` field. */
  exec?: Span;
  execSize?: number;
  channelOffset?: number;
  noMask: boolean;
  predicate?: RegisterRef;
  cmod?: { span: Span; condition: string; flag?: RegisterRef };
  operands: Operand[];
  /** The `{…}` field, braces included. */
  options?: Span;
  flags: { span: Span; name: string }[];
  swsbToken?: SwsbToken;
  swsbRegDist?: SwsbRegDist;
  comment?: Span;
  /** Every register named on the line, operands, predicate and cmod included. */
  registers: RegisterRef[];
  labels: LabelRef[];
  errors: { line: number; message: string }[];
  /** False when part of the line was not understood. The fields above are still best-effort. */
  ok: boolean;
}

export interface LabelDef {
  span: Span;
  name: string;
}

export interface Shader {
  /** Header text after `Native code for `, or a placeholder for a headerless listing. */
  name: string;
  /** Line of the `Native code for` header; absent for a headerless listing. */
  headerLine?: number;
  startLine: number;
  /** Last line that belongs to the shader, inclusive. */
  endLine: number;
  /** One-line summary taken from the stats line, e.g. `SIMD16, 32 instructions`. */
  summary?: string;
  instructions: Instruction[];
  labels: Map<string, LabelDef>;
}

export interface ParsedDocument {
  shaders: Shader[];
  kinds: LineKind[];
  /** Instruction on each line, if that line is one. */
  instructionAt: (Instruction | undefined)[];
}
