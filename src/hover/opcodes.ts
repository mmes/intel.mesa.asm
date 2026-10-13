// What each mnemonic does. The list of mnemonics is Mesa's (data/opcodes.json,
// written by tools/gen-opcodes.py); a test fails when one has no entry here.

export interface OpcodeDoc {
  summary: string;
  /** The result as a formula over `dst`, `src0`, `src1`, `src2`. */
  formula?: string;
  /** What each operand is, in printed order, where "source N" would not say enough. */
  roles?: string[];
}

const GFX9 = ' Gfx9 only.';

export const OPCODES: Record<string, OpcodeDoc> = {
  illegal: { summary: 'Illegal instruction; executing it raises an exception.' },
  nop: { summary: 'No operation. Used as padding.' },

  mov: { summary: 'Copy, converting from the source type to the destination type.', formula: 'dst = src0' },
  movi: { summary: 'Move indexed: copy from a register selected at run time.' },
  smov: { summary: 'Scattered move.' },
  sel: {
    summary: 'Per-channel select by the predicate. With a conditional modifier instead, it compares its own sources and is a min or max.',
    formula: 'dst = predicate ? src0 : src1',
  },
  csel: {
    summary: 'Three-source select on a comparison of src2 with zero.',
    formula: 'dst = (src2 <cond> 0) ? src0 : src1',
    roles: ['destination', 'value if true', 'value if false', 'value compared with zero'],
  },

  add: { summary: 'Add.', formula: 'dst = src0 + src1' },
  addc: { summary: 'Add with carry out: the carry of each channel goes to acc0.', formula: 'dst = src0 + src1' },
  subb: { summary: 'Subtract with borrow out: the borrow of each channel goes to acc0.', formula: 'dst = src0 - src1' },
  add3: { summary: 'Three-way add.', formula: 'dst = src0 + src1 + src2' },
  avg: { summary: 'Rounded average.', formula: 'dst = (src0 + src1 + 1) >> 1' },
  mul: { summary: 'Multiply, keeping the low half of the product.', formula: 'dst = src0 * src1' },
  mullh: { summary: 'Multiply producing both the low and high halves of the product.' },
  mac: { summary: 'Multiply and add to the accumulator.', formula: 'dst = acc0 + src0 * src1' },
  mach: {
    summary: 'Multiply-accumulate high: the high 32 bits of a 32×32 multiply, completing a preceding `mul` into acc0. The usual way to divide by a constant.',
    formula: 'dst = (acc0 + src0 * src1) >> 32',
  },
  macl: { summary: 'Multiply-accumulate low: the low 32 bits of the same accumulator product `mach` takes the high half of.' },
  mad: {
    summary: 'Multiply-add. Fused for floats.',
    formula: 'dst = src0 + src1 * src2',
    roles: ['destination', 'addend', 'multiplicand', 'multiplier'],
  },
  madm: { summary: 'Multiply-add for macro-instruction sequences (IEEE-exact divide and square root).' },
  dp4a: {
    summary: 'Four-way byte dot product, accumulated: each dword channel adds the products of its four byte pairs.',
    formula: 'dst = src0 + Σ(src1.byte[k] * src2.byte[k]), k = 0..3',
    roles: ['destination', 'accumulator in', 'bytes A', 'bytes B'],
  },
  dpas: {
    summary: 'Systolic dot-product accumulate: a matrix multiply-accumulate step run in the systolic array. Scoreboarded like a send.',
    formula: 'dst = src0 + src2 × src1',
    roles: ['destination (accumulator out)', 'accumulator in', 'B (VNNI layout)', 'A (row-major)'],
  },

  and: { summary: 'Bitwise AND.', formula: 'dst = src0 & src1' },
  or: { summary: 'Bitwise OR.', formula: 'dst = src0 | src1' },
  xor: { summary: 'Bitwise XOR.', formula: 'dst = src0 ^ src1' },
  not: { summary: 'Bitwise NOT.', formula: 'dst = ~src0' },
  shl: { summary: 'Shift left.', formula: 'dst = src0 << src1' },
  shr: { summary: 'Logical shift right (zero fill).', formula: 'dst = src0 >>> src1' },
  asr: { summary: 'Arithmetic shift right (sign fill).', formula: 'dst = src0 >> src1' },
  rol: { summary: 'Rotate left.' },
  ror: { summary: 'Rotate right.' },
  bfn: {
    summary: 'Three-input boolean function. The expression in the opcode is the function, bit by bit, of a = src0, b = src1, c = src2.',
    roles: ['destination', 'a', 'b', 'c'],
  },
  bfe: { summary: 'Bit-field extract: takes a field out of a value; the other two sources give its width and offset.' },
  bfi1: { summary: 'Bit-field insert, step 1: builds the mask for a field from its width and offset.' },
  bfi2: {
    summary: 'Bit-field insert, step 2: merges two values under a mask.',
    formula: 'dst = (src0 & src1) | (~src0 & src2)',
    roles: ['destination', 'mask', 'value where the mask is set', 'value where it is clear'],
  },
  bfrev: { summary: 'Reverse the bit order.' },
  cbit: { summary: 'Count set bits (popcount).' },
  fbh: { summary: 'Find first bit from the high end: for unsigned, the leading one; for signed, the first bit that differs from the sign.' },
  fbl: { summary: 'Find first set bit from the low end.' },
  lzd: { summary: 'Count leading zeros.' },

  cmp: {
    summary: 'Compare and write the result to a flag register, one bit per channel. The destination is usually `null`.',
    formula: 'flag = src0 <cond> src1',
  },
  cmpn: { summary: 'Compare with NaN-aware semantics, used to build min and max that propagate the non-NaN operand.' },

  frc: { summary: 'Fractional part.', formula: 'dst = src0 - floor(src0)' },
  rndd: { summary: 'Round down (floor).' },
  rndu: { summary: 'Round up (ceiling).' },
  rnde: { summary: 'Round to nearest, ties to even.' },
  rndz: { summary: 'Round toward zero (truncate).' },
  srnd: { summary: 'Stochastic rounding.' },
  math: {
    summary: 'Extended math function, named by the suffix. Runs in the math pipe and has long latency.',
    roles: ['destination', 'first input', 'second input (`null` for one-input functions)'],
  },

  send: {
    summary: 'Send a message to a shared function (memory, sampler, gateway, …). Completes asynchronously and is tracked by a scoreboard token.',
    roles: ['response', 'payload', 'second payload', 'extended descriptor', 'descriptor'],
  },
  sendc: { summary: 'Send, conditional on thread dependencies; used for render-target writes.' },
  sends: { summary: 'Split send: a send with a second payload register. Pre-Xe encoding.' },
  sendsc: { summary: 'Split send, conditional on thread dependencies. Pre-Xe encoding.' },
  sendg: { summary: 'Send with a single 64-bit descriptor (Xe3P).' },
  sendgc: { summary: 'Send with a single 64-bit descriptor, conditional on thread dependencies (Xe3P).' },

  sync: { summary: 'Wait on the software scoreboard without doing anything else. The suffix says what for.' },
  wait: { summary: 'Wait for a notification register to be signalled. The pre-Xe2 barrier wait.' },

  if: {
    summary: 'Start a conditional block. Channels whose predicate is false are disabled until the matching `else` or `endif`.',
    roles: ['JIP: where to jump if no channel takes the branch (the `else` or `endif`)', 'UIP: the `endif`'],
  },
  else: {
    summary: 'Swap which channels are active within the enclosing `if`.',
    roles: ['JIP: where to jump if no channel remains active', 'UIP: the `endif`'],
  },
  endif: {
    summary: 'End a conditional block and restore the channel mask.',
    roles: ['JIP: the next join point out of this block, not a jump to follow'],
  },
  while: {
    summary: 'End of a loop: jump back to the loop head while any channel is still active.',
    roles: ['JIP: the loop head'],
  },
  break: {
    summary: 'Leave the loop on the predicated channels: they stay disabled until the loop exits.',
    roles: ['JIP: where to jump if no channel remains active', 'UIP: the instruction after the loop'],
  },
  continue: {
    summary: 'Skip the rest of this iteration on the predicated channels: they stay disabled until the loop\'s `while`.',
    roles: ['JIP: where to jump if no channel remains active', 'UIP: the loop\'s `while`'],
  },
  halt: {
    summary: 'Disable the predicated channels until the matching halt target; used for discard.',
    roles: ['JIP: where to jump if no channel remains active', 'UIP: the halt target'],
  },
  goto: { summary: 'Unstructured jump on the predicated channels, re-enabled at a `join`.', roles: ['JIP', 'UIP: the target'] },
  join: { summary: 'Join point: re-enables channels that left through a `goto`.' },
  jmpi: { summary: 'Indexed jump of the whole thread, not per channel.' },
  brd: { summary: 'Branch diverging.' },
  brc: { summary: 'Branch converging.' },
  call: { summary: 'Call a subroutine.' },
  calla: { summary: 'Call a subroutine at an absolute address.' },
  ret: { summary: 'Return from a subroutine.' },

  dp2: { summary: `Two-component dot product.${GFX9}` },
  dp3: { summary: `Three-component dot product.${GFX9}` },
  dp4: { summary: `Four-component dot product.${GFX9}` },
  dph: { summary: `Homogeneous dot product.${GFX9}` },
  line: { summary: `Line equation evaluation.${GFX9}` },
  pln: { summary: `Plane equation evaluation, for interpolating attributes.${GFX9}` },
  lrp: { summary: `Linear interpolation.${GFX9}` },
};

export const MATH_FUNCTIONS: Record<string, string> = {
  inv: 'reciprocal, 1 / x', log: 'log2(x)', exp: '2^x', sqt: 'square root', rsq: 'reciprocal square root',
  sin: 'sine', cos: 'cosine', pow: 'x^y', intdiv_qr: 'integer divide, quotient and remainder',
  intdiv_q: 'integer divide, quotient', intdiv_r: 'integer divide, remainder', fdiv: 'float divide, x / y',
  tanh: 'hyperbolic tangent', invm: 'reciprocal, macro-instruction form', rsqrtm: 'reciprocal square root, macro-instruction form',
};

export const SYNC_FUNCTIONS: Record<string, string> = {
  nop: 'Nothing beyond the scoreboard annotation on this line, which is its whole purpose.',
  allwr: 'Waits for every outstanding write: all tokens\' destinations.',
  allrd: 'Waits for every outstanding read: all tokens\' sources.',
  bar: 'Waits on the workgroup barrier that a preceding gateway `barrier_msg` signalled.',
  fence: 'Waits for a memory fence to complete.',
  host: 'Waits for the host.',
};

export const FLAGS: Record<string, string> = {
  Compacted: '8-byte encoding instead of 16. No effect on behaviour.',
  EOT: 'End of thread: the thread terminates when this send completes.',
  AccWrEn: 'Also writes the result to the accumulator.',
  Atomic: 'The next instruction issues without a thread switch in between.',
  Switch: 'Forces a thread switch after this instruction.',
  NoDDChk: 'Legacy: skip the destination dependency check.',
  NoDDClr: 'Legacy: do not clear the destination dependency.',
  Align16: 'Legacy vec4 addressing mode.',
  Serialize: 'Fusion control: this instruction is not fused with its neighbours.',
  ExBSO: 'The extended descriptor register holds a bindless surface offset, and src1\'s length is encoded in the instruction.',
  Breakpoint: 'Debug trap.',
};

export const CONDITIONS: Record<string, string> = {
  eq: '==', ne: '!=', gt: '>', ge: '>=', lt: '<', le: '<=', ov: 'overflowed', un: 'is unordered (a NaN is involved)',
};

export const PIPES: Record<string, string> = {
  F: 'float', I: 'integer', L: 'long (64-bit)', M: 'math', S: 'scalar', A: 'any',
};

export const TYPES: Record<string, { size: number; name: string }> = {
  ub: { size: 1, name: 'unsigned byte' }, b: { size: 1, name: 'signed byte' },
  uw: { size: 2, name: 'unsigned word' }, w: { size: 2, name: 'signed word' },
  ud: { size: 4, name: 'unsigned dword' }, d: { size: 4, name: 'signed dword' },
  uq: { size: 8, name: 'unsigned qword' }, q: { size: 8, name: 'signed qword' },
  hf: { size: 2, name: 'half float' }, bf: { size: 2, name: 'bfloat16' },
  f: { size: 4, name: 'float' }, df: { size: 8, name: 'double' },
  v: { size: 4, name: 'packed vector of eight signed nibbles' },
  uv: { size: 4, name: 'packed vector of eight unsigned nibbles' },
  vf: { size: 4, name: 'packed vector of four 8-bit restricted floats' },
};
