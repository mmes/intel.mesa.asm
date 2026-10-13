# Roadmap

Milestones in the order they will be built. Each one leaves the extension
usable on its own. Design detail is in [architecture.md](architecture.md).

| Milestone | Delivers | Needs |
|---|---|---|
| M0 | Design documents | nothing |
| M1 | Installable extension with syntax colouring | Node.js |
| M2 | Parser, outline, folding, label navigation, highlights | M1 |
| M3 | Column alignment | M2 |
| M4 | Hovers | M2, generated tables |
| M5 | `gentool` bridge | M2, a Mesa build |
| M6 | Simulator back end | M5, a simulator |

M3, M4 and M5 depend only on M2 and can be done in any order.

## M0: design (this commit)

- README and the three documents under `docs/`.

## M1: scaffold and colouring (done, except as noted)

- Extension manifest, language registration, language configuration
  (comments, brackets).
- TextMate grammar covering every token class in
  [dump-format.md](dump-format.md), sections 2 to 5.
- A grammar test over the corpus, run by `test/run.sh`.

Packaging to a `.vsix` came with M2 (`npm run package`).

Result: the test passes on Mesa's four case files (2906 lines) and the sample
listings, with every instruction line recognised and no operand left
uncoloured. The same held on a large set of real driver dumps that are not
part of this repository. Not yet
checked: a `--hex` dump, an `ann` dump, non-compute stages, a mixed log with
NIR, and how the colours look in an actual editor window.

Done when: a shader dump, a `--hex` dump and Mesa's four round-trip
case files all colour correctly in a light and a dark theme, and a mixed log
with NIR in it shows no stray colouring outside the shader sections.

## M2: parser and structure (done)

- Line classifier and instruction tokeniser, with ranges.
- Document symbols: one entry per shader, labels nested under it.
- Folding: shaders; loops from a label to the `while` that names it;
  `if` / `else` / `endif`.
- Go to definition and find references on labels.
- Document highlight: every use of the register under the cursor within the
  shader; every `$N` set and wait for the token under the cursor.
- Diagnostics for `ERROR:` lines, attached to the instruction above.

Done when: every line of the corpus parses completely, and a 12 000-line dump
opens with outline and folding available in under a second.

Result: all 2906 case lines and the sample listings parse with every operand
and option recognised, and so did the real dumps outside the repository, with
no instruction partly parsed and no unresolved label. Parsing and folding a
12 000-line dump takes about 40 ms. The built extension was exercised against
a stand-in for the VS Code API, not in an editor window, so the outline,
folding, navigation and highlighting have not been seen working in VS Code.

Choices made while building:

- A register matches by number, whatever the sub-register, type or region:
  the cursor on `r4.1<2>:uw` highlights every `r4`. Flag sub-registers match
  exactly, since `f0.0` and `f0.1` are separate predicates.
- A scoreboard token highlights every `$N` in the shader. Tokens are reused,
  so that can span more than one send; the setting instruction is marked as a
  write to make each lifetime visible.
- A register reached through `r[a0.0]` is not tracked; only `a0.0` is.
- A listing with no `Native code for` header is treated as one shader, so
  labels and registers still have a scope.
- The parse is whole-document, cached per document version. It is fast enough
  that incremental parsing is not needed yet.

## M3: column alignment (done)

- Format Document and Format Selection, whitespace only.
- Settings: `intelEuAsm.format.columns` (`aligned` or `printer`),
  `maxOverflow`, `alignComments`.

Done when: formatting the corpus changes no non-whitespace character, the
result still assembles to the same bytes with `gentool asm`, and formatting
twice gives the same text as formatting once.

Result: on every corpus file, aligning changes whitespace only, a second pass
changes nothing, and `printer` mode then restores the original text exactly.
`printer` mode alone left every instruction line of the real dumps outside the
repository untouched, so the column model matches Mesa's printer on real
output. Not checked: assembling the result with `gentool asm`, which needs a
Mesa build, and the commands as run inside VS Code.

## M4: hovers (done, with the gaps listed)

Built as specified below, except:

- **Stats line fields** have no hover.
- **`P@N` links are estimates.** The instruction is found by assigning every
  instruction above to a pipe with the rules of Mesa's `inferred_exec_pipe()`
  and counting back in file order. Measured on real brw and jay dumps outside
  the repository, the instruction found writes a register the waiting
  instruction names, or one within eight numbers of it, in about 94% of
  cases. That check is loose, so the true hit rate is lower; the
  hover flags a link that fails it. jay assigns pipes from its own IR types,
  which the text does not show, so its links are the less certain ones.
- **"Last written" looks at the named register only.** For an operand that
  spans several registers (`dpas`, SIMD32 values) it finds the last write to
  the first one.
- **ALU detail** stops at the formula, operand extents and saturation. The
  execution type and implicit conversions are not described.
- **Control flow** hovers give the JIP and UIP targets but do not name the
  matching `if` or `endif`.
- **Send decoding** covers LSC messages and the gateway. Sampler, render
  target, URB before Xe2 and the legacy data ports show the printer's comment.
- **Opcode descriptions** are written from knowledge of the instruction set,
  not checked against the BSpec. The rarely seen ones (`smov`, `brd`, `brc`,
  `mullh`, `madm`, `srnd`) are one-liners.

Result: the send decoder produces the same message name as Mesa's comment on
every LSC and gateway send in the corpus, and on every send of the real dumps
outside the repository; and the same message, header, extended and response
lengths on every corpus send that prints them. A hover is produced for every
opcode, operand, annotation and flag in the corpus. All 78 Mesa opcodes have a
description. Not
seen in an editor window: how the tables and links render.

The hover on an opcode explains the whole instruction, and its content
depends on the kind of instruction. Hovers on other tokens explain that token.

Every instruction hover has:

- **Operands by role**, named for what they are in that instruction (for
  `dpas`: destination, accumulator in, B, A; for a send: response, payload,
  second payload, descriptors), each in its full form with the type and region
  the printer left out.
- **Where each source comes from**: a link to the instruction above that last
  wrote the register, the same lookup Go to Definition uses.
- **Execution**: channels covered, NoMask or predicated and on which flag,
  the flag a conditional modifier writes.
- **Scoreboard**: for `$N`, that this instruction owns token N and which later
  instructions wait on it; for `$N.dst` / `$N.src`, the instruction it waits
  for and whether it waits for the write or the read; for `P@N`, the
  instruction N back in that pipe. Each with a link.
- **Encoding flags** in the braces, each with its meaning.

By kind:

| Kind | In addition |
|---|---|
| Send | The message decoded from `desc` and `ex_desc`, field by field: operation, shared function, address size, data size, vector size, transpose, the VNNI bit on 2D block loads, cache control, address model and surface (flat, BTI n, bindless via `a0.2`, SLM base offset). Payload sizes: message, extended message and response length in GRFs and in bytes. Which registers the payload is made of, including the list read from `s0` for a gather send. Header presence. End of thread. |
| `dpas` | Depth and repeat count, the accumulator and source types, how many GRFs each of the four operands spans, and whether it chains from the previous `dpas`. |
| ALU | Semantics as a formula over the operands, the execution type, any conversion between source and destination types, saturation, and how many bytes of the destination register are written. |
| `math` | The function, one or two inputs, and that it runs in the math pipe. |
| Compare and select | The condition, the flag written, and for `sel` with a cmod that it is a min or max. |
| Control flow | What JIP and UIP mean for this opcode, the target lines, and the matching `if` / `else` / `endif` or loop head. |
| `sync` | What it waits for; for `sync.nop`, the annotation that is its whole purpose. |
| Three-source (`mad`, `add3`, `bfn`) | Operand order as a formula; for `bfn`, the truth table. |

Other tokens:

| Hover on | Shows |
|---|---|
| Operand | The full form (`r0.1<0>` is `r0.1<0;1,0>:ud`), the byte range it covers in the register, and which element each channel reads for a non-trivial region |
| Immediate | Other readings: float bits as a value, a `:v` or `:uq` vector as its elements |
| Scoreboard annotation | The same scoreboard explanation as on the opcode |
| Label | The target line and every instruction that branches to it |
| Stats line field | What the number counts |

Supporting work:

- Generators in `tools/` for opcode and name tables from a Mesa checkout.
- Hand-written one-line descriptions per mnemonic.
- A descriptor decoder for LSC messages (UGM, SLM, TGM, URB) and the gateway.
  Other shared functions show the printer's own comment until someone needs
  them decoded.

Done when: every mnemonic in Mesa's opcode list has a description, and the LSC
decode of every send in the corpus agrees with the message name the printer
wrote in that line's comment.

An earlier criterion, that the operand's full form match `gentool disasm
--verbose`, was dropped. The default print omits a sequential region, and its
exact `<v;w,h>` cannot be recovered from the text; the hover says "sequential"
instead of inventing one.

## M5: `gentool` bridge (done)

- Settings for the `gentool` path and the platform.
- Commands: disassemble a binary into a new editor; show the current listing in
  verbose, translated or byte-prefixed form; check the current file; assemble
  it to a binary file.
- Region diagram for the instruction under the cursor, by command and at the
  end of the instruction hover.
- Assembler and validator errors shown as diagnostics.

Done when: each command works against a current Mesa build and fails with a
readable message when `gentool` is missing or rejects the platform.

Result, against the gentool of a Mesa build from October 2026 as platform
`ptl`: each of the sample listings assembles without errors, and disassembling the result
gives back the original instruction for instruction, apart from the
differences below. The verbose, translated and byte-prefixed forms gentool
prints all parse completely. Parse errors and validation errors land on the
right source lines. A missing binary and an unknown platform each produce a
readable error. This tests the bridge module; the commands themselves, which
wrap it in dialogs and editors, have not been run in VS Code.

What had to be handled:

- **A dump is not valid `gentool asm` input.** Headers, statistics and
  comments are rejected, and so is the `Compacted` flag. The bridge blanks or
  strips them, keeping line numbers so errors still point at the right line.
- **Each shader is assembled separately**, since labels restart at `L0`.
- **Mesa logs device warnings on stderr** (`requires INTEL_FORCE_PROBE`), which
  are filtered out.

Round-trip differences in gentool itself, which the "Beside" views therefore
show:

- `send.ugm` comes back with `ExBSO` set (seen on `ptl` and `bmg`).
- `add3 (32) … r81:d` comes back as `r81<0>:d`, and every operand of a `dpas`
  gains `<0>` or `<0;0,0>`: a three-source operand written without a region is
  assembled as a scalar.
- `{I@2,$6.src}` comes back as `{@2,$6.src}`. This one is inherent: the
  combined encoding does not carry the pipe.

The first two look like assembler bugs worth reporting to whoever maintains
gentool: the binary gentool produces from a dump is not the binary the driver
produced.

## M6: simulator

Not specified yet. The intended result is stepping through a listing with
register, flag and mask state shown in VS Code's debug views. The work starts
with choosing the simulator and writing down its interface; see below.

## Open questions

| # | Question | Blocks | Current assumption |
|---|---|---|---|
| 1 | Which simulator is the back end, and how is it driven (library, process, socket)? | M6 | None. The model keeps instruction indices and addresses so any choice fits. |
| 2 | How does the extension learn the platform of a shader dump, which does not record it? | M4, M5 | A workspace setting, defaulting to the newest platform. |
| 3 | Should alignment rewrite the file or only change how it is displayed? | nothing | Built as a rewrite, by explicit command only. Revisit if that proves unwelcome. |
| 4 | Does first-line detection beat another extension's claim on `.asm`? | nothing yet | Unknown. No extension on the development machine claims `.asm`, so it has not come up. Fallback is a prompt. |
| 5 | Where will the extension be published: Marketplace, Open VSX, or `.vsix` only? | M1 packaging | `.vsix` only until it is useful to someone else. |
| 6 | What licence? | nothing | Decided: MIT, with Mesa's notice in `NOTICE` for the parts derived from it. |
| 7 | Should jay's IR dump and NIR get their own grammars? | nothing | Out of scope; revisit after M4. |
