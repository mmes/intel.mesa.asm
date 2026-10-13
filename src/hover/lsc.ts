// Decoding of send descriptors, following gen_encoding.cpp and the
// translated-send printers in gen_print.cpp. The names produced here are the
// ones the printer writes in a send's trailing comment, which is what the
// tests compare against.

const bits = (value: number, high: number, low: number) => (value >>> low) & (2 ** (high - low + 1) - 1);
const signExtend = (value: number, width: number) => (value & (1 << (width - 1)) ? value - 2 ** width : value);

/** Message, response and header fields common to every send descriptor. */
export interface MessageLengths {
  messageLength: number;
  responseLength: number;
  headerPresent: boolean;
}

export function decodeLengths(desc: number): MessageLengths {
  return { messageLength: bits(desc, 28, 25), responseLength: bits(desc, 24, 20), headerPresent: !!bits(desc, 19, 19) };
}

const LSC_OPCODES: Record<number, string> = {
  0: 'load', 2: 'load_cmask', 3: 'load_block2d', 4: 'store', 6: 'store_cmask', 7: 'store_block2d',
  8: 'atomic_inc', 9: 'atomic_dec', 10: 'atomic_load', 11: 'atomic_store', 12: 'atomic_add', 13: 'atomic_sub',
  14: 'atomic_min', 15: 'atomic_max', 16: 'atomic_umin', 17: 'atomic_umax', 18: 'atomic_cmpxchg',
  19: 'atomic_fadd', 20: 'atomic_fsub', 21: 'atomic_fmin', 22: 'atomic_fmax', 23: 'atomic_fcmpxchg',
  24: 'atomic_and', 25: 'atomic_or', 26: 'atomic_xor', 31: 'fence', 49: 'load_cmask_msrt', 50: 'store_cmask_msrt',
};
const OP_FENCE = 31;
const ADDR_SIZES: Record<number, string> = { 1: 'a16', 2: 'a32', 3: 'a64' };
const DATA_SIZES = ['d8', 'd16', 'd32', 'd64', 'd8u32', 'd16u32', 'd16bf32'];
const DATA_SIZE_NOTES = [
  '8-bit', '16-bit', '32-bit', '64-bit',
  '8-bit in memory, zero-extended to 32 bits in the register',
  '16-bit in memory, zero-extended to 32 bits in the register',
  '16-bit bfloat in memory, converted to 32-bit float in the register',
];
const VECTOR_LENGTHS = [1, 2, 3, 4, 8, 16, 32, 64];
const FENCE_SCOPES = ['threadgroup', 'local', 'tile', 'gpu', 'all_gpu', 'system_release', 'system_acquire'];
const FLUSH_TYPES = ['none', 'evict', 'invalidate', 'discard', 'clean', 'l3only', 'none_6'];
const ADDR_TYPES = ['flat', 'bss', 'ss', 'bti'];

// Cache control is encoded differently from Xe2 on, and loads and stores have separate tables.
const CACHE_LOAD_XE2: Record<number, string> = {
  2: 'uc.uc', 4: 'uc.ca', 5: 'uc.cc', 6: 'ca.uc', 8: 'ca.ca', 9: 'ca.cc', 10: 'st.uc', 12: 'st.ca', 14: 'ri.ri' };
const CACHE_LOAD: Record<number, string> = {
  1: 'uc.uc', 2: 'uc.ca', 3: 'ca.uc', 4: 'ca.ca', 5: 'st.uc', 6: 'st.ca', 7: 'ri.ca' };
const CACHE_STORE_XE2: Record<number, string> = {
  2: 'uc.uc', 4: 'uc.wb', 6: 'wt.uc', 8: 'wt.wb', 10: 'st.uc', 12: 'st.wb', 14: 'wb.wb' };
const CACHE_STORE: Record<number, string> = {
  1: 'uc.uc', 2: 'uc.wb', 3: 'wt.uc', 4: 'wt.wb', 5: 'st.uc', 6: 'st.wb', 7: 'wb.wb' };
const CACHE_WORDS: Record<string, string> = {
  uc: 'uncached', ca: 'cached', cc: 'cached, evict after read', st: 'streaming', ri: 'invalidate after read',
  wb: 'write-back', wt: 'write-through',
};

const is2dBlock = (op: number) => op === 3 || op === 7;
const hasCmask = (op: number) => op === 2 || op === 6 || op === 49 || op === 50;
const isAtomic = (op: number) => op >= 8 && op <= 26;
const usesLoadCache = (op: number) => op === 0 || op === 2 || op === 49;
export const isLscStore = (op: number) => op === 4 || op === 6 || op === 7 || op === 50;

/** The extended descriptor as written on the line: an immediate, `a0.N`, or `imm:a0.N`. */
export interface ExDesc {
  imm: number;
  /** The address sub-register number when the descriptor comes from `a0.N`. */
  reg?: number;
}

export interface Field {
  label: string;
  value: string;
}

export interface DecodedMessage {
  /** The printer's dotted name, e.g. `load.ugm.d32x64t.a32.bti[1]`. */
  name: string;
  opcode?: number;
  fields: Field[];
}

const hex = (n: number) => `0x${n.toString(16)}`;
const offsetText = (n: number) => (n >= 0 ? `A+${hex(n)}` : `A-${hex(-n)}`);

export function isLscSfid(sfid: string, xe2: boolean): boolean {
  return sfid === 'ugm' || sfid === 'slm' || sfid === 'tgm' || (sfid === 'urb' && xe2);
}

/**
 * Decodes an LSC (load/store/cache) message. `src1Length` is the `:n` printed
 * after src1; its bits are removed from the extended descriptor before the
 * surface fields are read.
 */
export function decodeLsc(
  sfid: string, desc: number, ex: ExDesc, src1Length: number | undefined, xe2: boolean,
): DecodedMessage {
  const op = bits(desc, 5, 0);
  const opName = LSC_OPCODES[op];
  if (!opName) return { name: '?', fields: [{ label: 'Operation', value: `unknown LSC opcode ${op}` }] };

  const addrType = bits(desc, 30, 29);
  const fields: Field[] = [{ label: 'Operation', value: `\`${opName}\` on \`${sfid}\`` }];
  const exMlenMask = xe2 ? 0x7c0 : 0x3c0;
  // With a register descriptor the immediate part is extra offset bits, not the usual layout.
  const surfaceBits = ex.reg !== undefined ? 0
    : src1Length === undefined ? (ex.imm & ~exMlenMask) >>> 0
    : (ex.imm & ~((src1Length << 6) & exMlenMask)) >>> 0;
  const immExtra = ex.reg !== undefined ? ex.imm : 0;

  if (op === OP_FENCE) {
    const scope = FENCE_SCOPES[bits(desc, 11, 9)];
    const flush = FLUSH_TYPES[bits(desc, 14, 12)];
    const routed = !!bits(desc, 18, 18);
    fields.push({ label: 'Scope', value: scope ?? '?' }, { label: 'Flush', value: flush ?? '?' });
    if (routed) fields.push({ label: 'Routing', value: 'routed to LSC' });
    if (addrType !== 0 || ex.reg !== undefined || surfaceBits || !scope || !flush) return { name: '?', opcode: op, fields };
    return { name: `${opName}.${sfid}.${scope}.${flush}${routed ? '.route_to_lsc' : ''}`, opcode: op, fields };
  }

  const dataSize = bits(desc, 11, 9);
  const dataName = DATA_SIZES[dataSize];
  fields.push({ label: 'Data size', value: dataName ? `\`${dataName}\`: ${DATA_SIZE_NOTES[dataSize]}` : '?' });
  if (!dataName) return { name: '?', opcode: op, fields };

  const cacheBits = xe2 || is2dBlock(op) ? bits(desc, 19, 16) : bits(desc, 19, 17);
  const cacheTable = usesLoadCache(op) ? (xe2 ? CACHE_LOAD_XE2 : CACHE_LOAD) : (xe2 ? CACHE_STORE_XE2 : CACHE_STORE);
  const cache = cacheBits === 0 ? '' : cacheTable[cacheBits];
  const cacheField = (): Field => ({
    label: 'Cache control',
    value: cacheBits === 0 ? 'default (from surface state / MOCS)'
      : cache ? `\`${cache}\`: L1 ${CACHE_WORDS[cache.slice(0, 2)]}, L3 ${CACHE_WORDS[cache.slice(3)]}`
      : `unknown (${cacheBits})`,
  });

  if (is2dBlock(op)) {
    const transpose = !!bits(desc, 15, 15);
    const vnni = !!bits(desc, 7, 7);
    const x = signExtend(bits(surfaceBits, 21, 12), 10);
    const y = signExtend(bits(surfaceBits, 31, 22), 10);
    fields.push(
      { label: 'Transpose', value: transpose ? 'yes' : 'no' },
      { label: 'VNNI', value: vnni ? 'yes: rows are interleaved into the layout `dpas` expects for its B operand' : 'no' },
      { label: 'Address', value: '`a64` flat; src0 holds the block descriptor' },
      { label: 'Block offset', value: `x ${x}, y ${y}` },
      cacheField());
    let name = `${opName}.${sfid}.${dataName}${transpose ? 't' : ''}${vnni ? 'v' : ''}.a64`;
    if (sfid !== 'ugm' || addrType !== 0 || ex.reg !== undefined) return { name: '?', opcode: op, fields };
    name += cache === undefined ? '.?' : cache ? `.${cache}` : '';
    return { name, opcode: op, fields };
  }

  let name = `${opName}.${sfid}.${dataName}`;
  if (hasCmask(op)) {
    const cmask = bits(desc, 15, 12);
    const channels = ['x', 'y', 'z', 'w'].filter((_, i) => cmask & (1 << i)).join('');
    fields.push({ label: 'Channel mask', value: channels ? `\`${channels}\`` : 'none' });
    if (!channels) return { name: `${name}.?`, opcode: op, fields };
    name += `.${channels}`;
  } else if (!isAtomic(op)) {
    const count = VECTOR_LENGTHS[bits(desc, 14, 12)];
    const transpose = !!bits(desc, 15, 15);
    fields.push({
      label: 'Vector size',
      value: transpose
        ? `${count} elements, transposed: one address, ${count} consecutive elements filling registers in order (a block)`
        : count === 1 ? '1 element per address' : `${count} elements per address`,
    });
    if (count !== 1 || transpose) name += `x${count}${transpose ? 't' : ''}`;
  }

  const addrSize = ADDR_SIZES[bits(desc, 8, 7)];
  fields.push({ label: 'Address size', value: addrSize ? `\`${addrSize}\`` : '?' });
  if (!addrSize) return { name: `${name}.?`, opcode: op, fields };
  name += `.${addrSize}`;

  fields.push(cacheField());
  if (cache === undefined) return { name: `${name}.?`, opcode: op, fields };
  if (cache) name += `.${cache}`;

  // The surface: which address space the addresses in src0 are relative to.
  let surface: string | undefined;
  let surfaceNote: string;
  const flatOffset = signExtend(bits(surfaceBits, 31, 12), 20);
  switch (ADDR_TYPES[addrType]) {
    case 'flat':
      surfaceNote = sfid === 'slm' ? 'shared local memory' : 'flat: the address is a full virtual address';
      if (flatOffset) surfaceNote += `, plus immediate offset ${hex(flatOffset)}`;
      if (ex.reg !== undefined) break;
      if (sfid === 'slm') surface = flatOffset ? undefined : '';
      else surface = flatOffset ? `.flat[${offsetText(flatOffset)}]` : '';
      break;
    case 'bss':
    case 'ss': {
      const kind = ADDR_TYPES[addrType];
      const base = signExtend((bits(immExtra, 31, 19) << 4) | bits(immExtra, 15, 12), 17);
      surfaceNote = `${kind === 'bss' ? 'bindless surface' : 'surface state'}: offset of the surface state `
        + (ex.reg !== undefined ? `is in \`a0.${ex.reg / 2}\`` : `is ${hex(bits(surfaceBits, 31, 6))}`);
      if (base) surfaceNote += `, plus immediate offset ${hex(base)}`;
      if (ex.reg !== undefined && sfid !== 'slm' && sfid !== 'urb') {
        surface = `.${kind}[a0.${ex.reg / 2}]${base ? `[${offsetText(base)}]` : ''}`;
      }
      break;
    }
    default: {
      const index = bits(surfaceBits, 31, 24);
      const base = signExtend(bits(surfaceBits, 23, 12), 12);
      surfaceNote = `binding table entry ${index}`;
      if (base) surfaceNote += `, plus immediate offset ${hex(base)}`;
      if (ex.reg === undefined && sfid !== 'slm' && sfid !== 'urb') {
        surface = `.bti[${index}]${base ? `[${offsetText(base)}]` : ''}`;
      }
    }
  }
  fields.push({ label: 'Surface', value: surfaceNote });
  return { name: name + (surface ?? '.?'), opcode: op, fields };
}

const GATEWAY = ['open', 'close', 'forward_msg', 'get_timestamp', 'barrier_msg', 'update_state', 'mmio_rw'];
const GATEWAY_NOTES: Record<string, string> = {
  open: 'opens the gateway; with EOT this is the usual end-of-thread message',
  barrier_msg: 'signals the workgroup barrier; a `sync.bar` then waits for the other threads',
};

/** Decodes a message-gateway send. `execSize` is appended as the printer does. */
export function decodeGateway(desc: number, execSize: number | undefined): DecodedMessage {
  const op = GATEWAY[desc & 7];
  if (!op || desc & 0x7fff8) return { name: '?', fields: [] };
  return {
    name: `${op} (${execSize ?? '?'})`,
    fields: [{ label: 'Operation', value: `\`${op}\`${GATEWAY_NOTES[op] ? `: ${GATEWAY_NOTES[op]}` : ''}` }],
  };
}
