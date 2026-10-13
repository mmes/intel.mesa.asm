# The dump format

This is the input specification for the extension: which files it opens, what
kinds of line they contain, and which tokens it has to tell apart. It is a
summary for implementers, not a guide to reading EU assembly.

The format is whatever Mesa's printer emits. The authoritative sources, all
under `src/intel/compiler/gen/` in a Mesa checkout, are:

| File | Defines |
|---|---|
| `gen_print.cpp` | Line layout, column positions, which fields are omitted by default |
| `gen_parse.cpp` | The grammar `gentool asm` accepts, which is the same text |
| `gen_names.c` | Spellings of registers, types, conditions, SFIDs, pipes, option flags |
| `gen_opcodes.py` | The opcode list: mnemonic, format, source count, per-generation hardware opcode |
| `xe.json`, `pre_xe.json` | Bit-field layouts of the encodings |
| `tests/*.txt` | About 3000 round-trip cases, each a real instruction line |

Examples below are lines from those test files or written for this document.

## 1. File kinds

| Kind | Produced by | Distinguishing feature |
|---|---|---|
| Shader dump | `INTEL_DEBUG=cs` or `shaders` | `Native code for …` header per shader, a stats line, labels |
| Shader dump with bytes | the same plus `INTEL_DEBUG=hex` | Each instruction is prefixed with its encoded bytes |
| Annotated shader dump | the same plus `INTEL_DEBUG=ann` | `// …` lines carrying the NIR each group of instructions came from |
| `gentool disasm` output | `gentool disasm -p PLATFORM` | No header; `--verbose`, `--translated-sends`, `--hex` change the line form |
| Round-trip case file | Mesa's `tests/*.txt` | `platform \| bytes \| assembly` on every line |
| Mixed log | a driver log with `NIR_DEBUG` or another IR dump enabled | Shader dumps embedded between unrelated text |

One file may hold many shaders. A mixed log must not break anything: lines that
are not recognised are left uncoloured and ignored by the parser.

## 2. Line kinds

```
Native code for unnamed compute shader  (src_hash 0x0000000000000001) (blake3 0000…)
SIMD16 shader: 16 instructions. 1 loops. 1100 cycles. 0:0 spills:fills, 3 sends, …

// 4054 cycles
(W)     mov (16)                  r8            r0.1<0>                           {Compacted}
L0: // 300 cycles
        while (16)                            L0
    ERROR: …
```

| Line kind | Recognised by | Notes |
|---|---|---|
| Shader header | `^Native code for ` | Starts a shader: `<name> (src_hash …) (blake3 …)`. |
| Stats line | `^SIMD\d+ shader: ` | After the header: instructions, loops, cycles, spills and fills, sends, scheduling mode, code size. A second form, `<STAGE> SIMD16 shader: N inst, …`, is printed when the compiler is asked for statistics. |
| Label | `^L\d+:` | A branch target, numbered in address order. May carry a trailing comment. |
| Comment | `^\s*//` | Block cycle estimate or NIR annotation. |
| Validator error | `^\s*ERROR: ` | Printed indented, directly under the instruction it is about; there may be several. |
| Instruction | anything else that parses | Section 3. |
| Round-trip case | `^[a-z][a-z0-9]{2} \| ` | Section 5. |

## 3. Instruction lines

```
(W)     mov (16)                  r8            r0.1<0>                           {Compacted}
        cmp (16)       (ge)f0.0   null          r14               r2<0>           {I@2}
(f0.0)  sel (16)                  r33:uw        r32:uw            r31:uw          {I@3}
│       │   │          │          │             │                 │               │
prefix  op  exec       cmod       dst           src0              src1            options
```

The printer pads each field to a fixed column. A field longer than its column
pushes everything after it to the right on that line only, which is what the
alignment feature repairs (see [architecture.md](architecture.md), section 5).

| Field | Forms |
|---|---|
| prefix | `(W)`, `(f0.0)`, `(~f0.0)`, `(W&f0.0)`, `(W&~f0.0)`, `(f0.0.any)`, `(f0.0.all)`; empty otherwise |
| opcode | `nop` is the only instruction printed without an exec size. Otherwise a mnemonic plus dotted suffixes: `add.sat`, `send.ugm`, `math.exp`, `sync.allwr`, `dpas.8x8`, `goto.b`, `bfn.(a ^ ~b & c)` |
| exec | `(16)`, or `(16\|M16)` with a channel offset |
| cmod | `(ge)f0.0`; conditions `eq ne gt ge lt le ov un` |
| dst | register, optional `<stride>`, optional `:type` |
| src0..src2 | optional `-` / `(abs)` / `-(abs)`, then a register with optional `<region>` and `:type`, or an immediate |
| options | `{A,B,…}`: encoding flags, then scoreboard annotations |
| comment | `// …`; on sends, `// wr:M+E, rd:R; <decoded message>` |

The `bfn` opcode contains spaces and parentheses. It is the one place where
splitting a line on whitespace gives the wrong fields.

### 3.1 Registers

| Class | Spellings |
|---|---|
| General | `r0` … `r255`, sub-register `r1.2` |
| Null | `null` |
| Address | `a0`, `a0.N` |
| Accumulator | `acc0`, `acc1`, with `.N` |
| Flag | `f0.0`, `f0.1`, `f1.0`, `f1.1` |
| Scalar (Xe3) | `s0`, `s0.N` |
| State, control, notification | `sr0.N`, `cr0.N`, `n0.N` |
| Others | `ip`, `tdr`, `tm0`, `mask0` |
| Indirect | `r[a0.0]`, `r[a0.0 + 32]`, `r[s0.0]` |

### 3.2 Types

`:ub :b :uw :w :ud :d :uq :q :hf :bf :f :df`, and on immediates only
`:v :uv :vf`. The default printer never writes `:ud`; an operand with no suffix
is `:ud`.

### 3.3 Regions

| Printed | Where |
|---|---|
| `<N>` | destination stride; source shorthand for `<N;1,0>` and equivalent strides |
| `<v;w,h>` | full source region, e.g. `<4;2,2>`, `<8;8,1>` |
| `<v;h>` | src0 and src1 of three-source instructions |
| `<VxH;1,0>` | per-channel indirect |
| `.xyxy`, `.r` | Align16 swizzle after the region, pre-Xe only |

Sequential regions and zero sub-register numbers are omitted by default. The
verbose form writes all of it: `r1.0<1>:f`, `r2.0<8;8,1>:f`, `(8|M0)`.

### 3.4 Immediates

| Printed | Type |
|---|---|
| `0x000000ff` | ud |
| `0:d`, `-5:d`, `9:w`, `2047:uw` | integer, decimal |
| `0x3f800000:f`, `0xfbff:hf` | float, as raw bits |
| `0x000000002b2a2928:uq` | 64-bit |
| `0x11001010:v` | packed vector |

### 3.5 Options and scoreboard

Flags: `Compacted EOT AccWrEn Atomic Switch NoDDChk NoDDClr Align16 Serialize
ExBSO Breakpoint`.

Scoreboard: `P@N` with pipe `F I L M S A` and a distance, and `$N`, `$N.dst`,
`$N.src` with a token number 0 to 31. `{I@2,$11.src}` combines one of each.
Platforms with a single pipe print the distance alone: `{@3,$1.dst}`.

### 3.6 Branch operands

Shader dumps print labels: `while (16) L0`, `if (16) jip:L1 uip:L2`. `gentool
disasm --program-subset` and the case files print numeric offsets instead:
`goto (16) jip:0x20 uip:0x20`.

## 4. Send lines

```
(W)     send.ugm (1)              r24     r20    null:0  0x00000000  0x0210D580   {L@1,$2}  // wr:1+0, rd:1; load.ugm.d32x16t.a64
        │        │                │       │      │       │           │            │            │
        sfid     exec             dst     src0   src1:n  ex_desc     desc         options      wr/rd + decoded message
```

Sends use a different, narrower column layout from other instructions. `src1`
carries a length (`r20:1`, `null:0`), and `ex_desc` is either an immediate, a
register (`a0.2`), or both (`0x00080000:a0.2`). A gather send prints `src0` as
`r[s0.0]`.

With `--translated-sends` the LSC message replaces the opcode and the operands
change shape:

```
load.slm.d32x4.a32 (16)   r10:8   r8:2
load_block2d.ugm.d8tv.a64 (1) r10:4 [r80:1 + (4, 4)]                      {ExBSO}
atomic_add.ugm.d32.a32.wt.wb.bss[a0.0] (8) r40:1 r35:1 r8:1
```

The trailing comment on a raw send is free text produced by per-SFID decoders
and differs between generations (`simd8_write off=1 (8)`, `ld_lz:u,v,r (8)
bti(1) using sampler index 0`, `load.ugm.d32.a32.bti[0]`). The extension treats
it as a comment and parses only the `wr:`/`rd:` prefix and, for LSC, the dotted
message name.

## 5. Round-trip case lines

```
tgl | 40 00 03 00 20 82 05 05 04 06 10 02 2a 00 00 00 |         add (8)                   r5            r6                0x0000002a
bmg | 31 00 00 00 00 00 16 06 8c 05 00 fa 00 00 78 02 <         load.ugm.d32x32t.a32.ca.cc.bss[a0.0] (1) r6:2 r5:1
```

Three fields: a 3-character platform (`skl`, `tgl`, `dg2`, `mtl`, `bmg`, `nvl`), the encoded bytes (8 for a compacted
instruction, 16 otherwise), and an instruction line as in section 3. The second
separator is `|` (check both directions), `<` (encode only) or `>` (decode
only). The file-name suffix selects the print mode: `_verbose.txt`,
`_translated.txt`.

These files are the parser's test corpus, and they are the only input that
states its platform. A shader dump does not say which platform it was compiled
for; see the open questions in [roadmap.md](roadmap.md).

## 6. What is out of scope

- NIR and other IR text. A mixed log may contain it; the extension skips it.
- Gfx8 and older. `gentool` supports Gfx9 onwards, and so does this extension.
- The pre-`gen` disassembler's output (`brw_disasm`, and `elk_disasm` for old
  hardware), which uses a different syntax.
