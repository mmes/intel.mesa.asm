// Everything a send instruction says once its descriptors are decoded.

import type { Instruction, Operand } from '../parser/model.ts';
import { versionOf, type Generation } from '../platform.ts';
import { decodeGateway, decodeLengths, decodeLsc, isLscSfid, type DecodedMessage, type ExDesc, type MessageLengths } from './lsc.ts';

export interface SendInfo {
  /** Shared function: `ugm`, `slm`, `gtwy`, … */
  sfid: string;
  dst: Operand;
  src0: Operand;
  src1?: Operand;
  exDesc: Operand;
  desc: Operand;
  /** Absent when the descriptor is in a register and cannot be read from the line. */
  lengths?: MessageLengths;
  /** GRFs in src1; absent when it is only known at run time. */
  extendedLength?: number;
  message?: DecodedMessage;
  /** The message name the printer wrote in the trailing comment, if any. */
  printedName?: string;
}

const HEX = /^0x[0-9a-fA-F]+$/;

export function analyzeSend(inst: Instruction, text: string, generation: Generation): SendInfo | undefined {
  if (!/^send(?:c|s|sc)?$/.test(inst.opcode.name)) return undefined;
  const ops = inst.operands;
  if (ops.length !== 4 && ops.length !== 5) return undefined;
  // Descriptor layouts changed with Xe2.
  const xe2 = versionOf(inst, generation) >= 200;
  const [dst, src0] = ops;
  const src1 = ops.length === 5 ? ops[2] : undefined;
  const exDesc = ops[ops.length - 2];
  const desc = ops[ops.length - 1];
  const info: SendInfo = { sfid: inst.opcode.suffix.replace(/^\./, ''), dst, src0, exDesc, desc, ...(src1 ? { src1 } : {}) };

  const src1Length = src1 && /:(\d+)$/.exec(src1.text)?.[1];
  const exMatch = /^(?:(0x[0-9a-fA-F]+))?:?(?:a0\.(\d+))?$/.exec(exDesc.text);
  const ex: ExDesc | undefined = exMatch
    ? { imm: exMatch[1] ? Number(exMatch[1]) : 0, ...(exMatch[2] ? { reg: Number(exMatch[2]) * 2 } : {}) }
    : undefined;

  if (src1Length !== undefined) info.extendedLength = Number(src1Length);
  else if (ex && ex.reg === undefined) info.extendedLength = (ex.imm >>> 6) & (xe2 ? 0x1f : 0xf);

  if (inst.comment) info.printedName = /;\s*(.*)$/.exec(text.slice(inst.comment.start, inst.comment.end))?.[1];

  if (HEX.test(desc.text)) {
    const value = Number(desc.text);
    info.lengths = decodeLengths(value);
    if (ex && isLscSfid(info.sfid, xe2)) {
      info.message = decodeLsc(info.sfid, value, ex, src1Length === undefined ? undefined : Number(src1Length), xe2);
    } else if (info.sfid === 'gtwy') {
      info.message = decodeGateway(value, inst.execSize);
    }
  }
  return info;
}
