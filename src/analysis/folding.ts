import type { ParsedDocument } from '../parser/model.ts';

export interface Fold {
  start: number;
  /** Last folded line, inclusive. */
  end: number;
}

/**
 * Foldable regions: each shader, each loop from its head label to the `while`
 * that names it, and each arm of an `if` / `else` / `endif`.
 */
export function foldingRanges(doc: ParsedDocument): Fold[] {
  const folds: Fold[] = [];
  const add = (start: number, end: number) => {
    // Do not swallow the blank line or label that precedes the closing instruction.
    while (end > start && (doc.kinds[end] === 'other' || doc.kinds[end] === 'label')) end--;
    if (end > start) folds.push({ start, end });
  };

  for (const shader of doc.shaders) {
    add(shader.startLine, shader.endLine);

    const open: number[] = [];
    for (const inst of shader.instructions) {
      switch (inst.opcode.name) {
        case 'while': {
          const head = inst.labels[0] && shader.labels.get(inst.labels[0].name);
          if (head && head.span.line < inst.line) folds.push({ start: head.span.line, end: inst.line });
          break;
        }
        case 'if':
          open.push(inst.line);
          break;
        case 'else': {
          const start = open.pop();
          if (start !== undefined) add(start, inst.line - 1);
          open.push(inst.line);
          break;
        }
        case 'endif': {
          const start = open.pop();
          if (start !== undefined) add(start, inst.line - 1);
          break;
        }
      }
    }
  }
  return folds;
}
