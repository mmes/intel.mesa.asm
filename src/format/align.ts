// Column alignment. Rewrites only the whitespace between the fields of
// instruction lines; see docs/architecture.md, section 5.

import type { Instruction, ParsedDocument, Shader, Span } from '../parser/model.ts';
import { hasDestination, isBranch } from '../parser/parse.ts';

export interface FormatOptions {
  /**
   * `aligned` widens columns until every line of a shader agrees. `printer`
   * restores the fixed columns Mesa prints, overflow included.
   */
  columns: 'aligned' | 'printer';
  /** A field that overflows its printer column by more than this is left overflowing instead of widening the column. */
  maxOverflow: number;
  /** Line up the trailing `//` comments of sends. */
  alignComments: boolean;
}

export const DEFAULT_FORMAT: FormatOptions = { columns: 'aligned', maxOverflow: 12, alignComments: true };

export interface LineEdit {
  line: number;
  text: string;
}

// Slots, in the order fields appear on a line. Each instruction format uses
// its own operand slots, as in gen_print.cpp, so a send's narrow columns do
// not have to agree with an ALU instruction's wide ones.
const PREFIX = 0;
const OPCODE = 1;
const CMOD = 2;
const ALU_DST = 10;
const ALU_SRC = 11;
const SEND_DST = 20;
const SEND_SRC0 = 21;
const SEND_SRC1 = 22;
const SEND_EX_DESC = 23;
const SEND_DESC = 24;
const BRANCH_JIP = 30;
const OPTIONS = 90;
const COMMENT = 91;

const SRC_STRIDE = 18;
const COMMENT_GAP = 2;

/** The column gen_print.cpp pads each slot to. */
function printerColumn(slot: number): number {
  switch (slot) {
    case PREFIX: return 0;
    case OPCODE: return 8;
    case CMOD: return 23;
    case ALU_DST: case SEND_DST: return 34;
    case SEND_SRC0: return 42;
    case SEND_SRC1: return 49;
    case SEND_EX_DESC: return 57;
    case SEND_DESC: return 69;
    case BRANCH_JIP: return 46;
    case BRANCH_JIP + 1: return 66;
    case OPTIONS: return 82;
    case COMMENT: return 87;
    default: return 48 + SRC_STRIDE * (slot - ALU_SRC);
  }
}

interface Field {
  slot: number;
  /** Empty for a column the printer advances to without printing anything. */
  text: string;
}

const RAW_SEND = /^send[a-z]*$/;
const TRANSLATED_SEND = /^(?:load|store|atomic|fence)/;

function fieldsOf(inst: Instruction, text: string): Field[] | undefined {
  const cut = (s: Span) => text.slice(s.start, s.end);
  const fields: Field[] = [];
  if (inst.prefix) fields.push({ slot: PREFIX, text: cut(inst.prefix) });
  fields.push({ slot: OPCODE, text: text.slice(inst.opcode.span.start, inst.exec?.end ?? inst.opcode.span.end) });
  if (inst.cmod) fields.push({ slot: CMOD, text: cut(inst.cmod.span) });

  const operands = inst.operands.map((o) => o.text);
  const name = inst.opcode.name;
  let slots: number[];
  if (isBranch(name)) {
    slots = operands.map((_, i) => BRANCH_JIP + i);
    if (operands.length > 2) return undefined;
  } else if (RAW_SEND.test(name)) {
    // dst src0 [src1] ex_desc desc. Sends from before split sends have no
    // src1, and `sendg` has one combined descriptor.
    if (operands.length === 5) slots = [SEND_DST, SEND_SRC0, SEND_SRC1, SEND_EX_DESC, SEND_DESC];
    else if (operands.length === 4 && name === 'sendg') slots = [SEND_DST, SEND_SRC0, SEND_SRC1, SEND_EX_DESC];
    else if (operands.length === 4) slots = [SEND_DST, SEND_SRC0, SEND_EX_DESC, SEND_DESC];
    else return undefined;
    if (!slots.includes(SEND_SRC1)) fields.push({ slot: SEND_SRC1, text: '' });
  } else if (TRANSLATED_SEND.test(name)) {
    const first = name.startsWith('store') ? SEND_SRC0 : SEND_DST;
    slots = operands.map((_, i) => first + i);
    if (first !== SEND_DST) fields.push({ slot: SEND_DST, text: '' });
    if (slots.some((s) => s > SEND_SRC1)) return undefined;
  } else {
    const first = hasDestination(name) ? ALU_DST : ALU_SRC;
    slots = operands.map((_, i) => first + i);
  }
  operands.forEach((o, i) => fields.push({ slot: slots[i], text: o }));

  if (inst.options) fields.push({ slot: OPTIONS, text: cut(inst.options) });
  if (inst.comment) fields.push({ slot: COMMENT, text: cut(inst.comment) });
  return fields.sort((a, b) => a.slot - b.slot);
}

/**
 * Where a field starts, given where the previous one ended: at its column
 * when that is still ahead, otherwise after a single space. This is the
 * printer's field_sep().
 */
function place(cursor: number, column: number, slot: number): number {
  if (slot === COMMENT) return Math.max(column, cursor + COMMENT_GAP);
  if (cursor < column || slot === PREFIX) return column;
  return cursor + 1;
}

interface Row {
  inst: Instruction;
  fields: Field[];
  cursor: number;
  out: string;
  /** Set while the line runs past its columns because of an outlier field. */
  loose: boolean;
}

function alignShader(shader: Shader, lines: readonly string[], options: FormatOptions): Row[] {
  const rows: Row[] = [];
  for (const inst of shader.instructions) {
    if (!inst.ok) continue;
    let fields = fieldsOf(inst, lines[inst.line]);
    if (!fields) continue;
    // Empty fields only reproduce a quirk of the printer's overflow spacing.
    if (options.columns === 'aligned') fields = fields.filter((f) => f.text);
    rows.push({ inst, fields, cursor: 0, out: '', loose: false });
  }

  const slots = [...new Set(rows.flatMap((r) => r.fields.map((f) => f.slot)))].sort((a, b) => a - b);
  const next = new Map<Row, number>(rows.map((r) => [r, 0]));

  for (const slot of slots) {
    const users = rows.filter((r) => r.fields[next.get(r)!]?.slot === slot);
    let column = printerColumn(slot);
    const free = slot === COMMENT && (options.columns === 'printer' || !options.alignComments);
    if (free) column = 0;

    if (options.columns === 'aligned' && !free) {
      for (const row of users) {
        const i = next.get(row)!;
        const before = row.fields[i - 1];
        // How far this line's previous field would overflow in the printer's
        // own layout decides whether it may widen the column for everyone.
        const overflow = before
          ? printerColumn(before.slot) + before.text.length + 1 - printerColumn(slot)
          : 0;
        if (overflow > options.maxOverflow) row.loose = true;
        if (!row.loose) column = Math.max(column, place(row.cursor, 0, slot));
      }
    }

    for (const row of users) {
      const field = row.fields[next.get(row)!];
      const start = place(row.cursor, column, slot);
      // Back on the grid: later fields may shape their columns again.
      if (row.cursor < column) row.loose = false;
      if (field.text) row.out += ' '.repeat(start - row.out.length) + field.text;
      row.cursor = field.text ? start + field.text.length : start;
      next.set(row, next.get(row)! + 1);
    }
  }
  return rows;
}

/**
 * Returns replacement text for every instruction line whose spacing changes.
 * Lines the parser did not fully understand are never touched. Columns are
 * worked out over whole shaders even when `range` limits which lines are
 * rewritten, so a formatted selection agrees with the rest of its shader.
 */
export function alignColumns(
  lines: readonly string[], doc: ParsedDocument, options: FormatOptions = DEFAULT_FORMAT,
  range?: { start: number; end: number },
): LineEdit[] {
  const edits: LineEdit[] = [];
  for (const shader of doc.shaders) {
    if (range && (shader.endLine < range.start || shader.startLine > range.end)) continue;
    for (const row of alignShader(shader, lines, options)) {
      const { line, column0 } = row.inst;
      if (range && (line < range.start || line > range.end)) continue;
      const original = lines[line];
      // Keep a platform or byte prefix exactly as it was.
      const text = original.slice(0, column0) + row.out;
      if (text !== original.trimEnd()) edits.push({ line, text });
    }
  }
  return edits;
}
