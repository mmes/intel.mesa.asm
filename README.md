# intel.mesa.asm

A VS Code extension for reading Intel GPU (EU) assembly dumps produced by Mesa:
the listings that `INTEL_DEBUG=cs` / `shaders` print, and the output of Mesa's
`gentool disasm`.

**Status: colouring, structure, column alignment, hovers and the `gentool`
bridge work (M1 to M5).** The simulator back end is not specified yet.

## What works

- Syntax colouring of shader dumps, `gentool` output and round-trip case files.
  Sends, `dpas` and `math`, which run long or complete out of order, get their
  own bold opcode colour (scope `support.function.mnemonic.async`).
- Outline and breadcrumbs: one entry per shader, with its labels; loop heads
  are marked.
- Folding of shaders, loops, and each arm of an `if` / `else` / `endif`.
- Go to Definition: on a label, its line; on a register, the last instruction
  above that wrote it; on a scoreboard wait (`$5.dst`), the instruction that
  set the token; on a pipe distance (`I@2`), the instruction it counts back
  to. Find All References works on the same three things.
- Highlighting, when the cursor is on one, of every use of a register, a
  scoreboard token (`$5`, `$5.dst`, `$5.src`) or a label within the shader.
  Writes and the instruction that sets a token are marked differently from
  reads.
- With the cursor on an opcode, the same highlighting for every register that
  instruction's operands name, so its inputs and outputs can be followed
  through the shader at once.
- Validator `ERROR:` lines shown as problems on the instruction they reject.
- Format Document and Format Selection re-align the operand columns of each
  shader. Only whitespace between fields changes. Setting
  `intelEuAsm.format.columns` to `printer` makes the same command restore
  Mesa's original spacing. Formatting on save is off for this language.

- Hovers:
  - on an opcode, the whole instruction: what it does, each operand by role
    in its full form with the registers it covers, a link to where each source
    was last written, how it is masked and predicated, what its scoreboard
    annotations wait for or who waits on it, and its encoding flags;
  - on a send's opcode, also the message decoded from its descriptors (data
    size, vector size, transpose, VNNI, cache control, surface), payload and
    response sizes, and the registers a gather send collects;
  - on an operand, its full form, type, region, the bytes it covers and where
    it was last written; on an immediate, its value (float bits decoded);
  - on a scoreboard annotation, flag, label, predicate or exec size, what that
    one thing means.

A dump does not say which platform it is from. Register size, descriptor
layout and the pipe each instruction runs in depend on it, so set
`intelEuAsm.generation` to match: `xe3p`, `xe3` (the default), `xe2`, `xe-hpg`
or `xe-lp`.

A pipe distance such as `I@2` is resolved by classifying every instruction
above into a pipe with Mesa's brw rules and counting back in file order. It is
an estimate: the hover says so when the instruction it lands on writes nothing
the waiting instruction uses, or when a branch or label lies in between.

"Above" for registers means earlier in the file. A value written lower in a
loop body and carried round the back edge is not found.

## Using gentool

The commands below are in the command palette and the editor's context menu,
under **Intel EU Asm**. They need the `gentool` binary of a Mesa build
(`<build>/src/intel/compiler/gen/gentool`). Run **Intel EU Asm: Select gentool
Binary…** to pick it, or set `intelEuAsm.gentool.path` yourself; a command run
before that offers to do it.

| Command | Does |
|---|---|
| Check with gentool | Assembles and validates the listing; problems appear on the lines they are about |
| Show Verbose Form Beside | Re-prints the listing with every region, type and sub-register written out |
| Show Translated Sends Beside | Re-prints it with LSC sends as `load.ugm…` mnemonics |
| Show with Encoded Bytes Beside | Re-prints it with each instruction's bytes |
| Show Register Regions of Instruction | gentool's drawing of the register bytes the instruction under the cursor touches |
| Assemble to Binary File… | Writes the encoded instructions of a single-shader listing |
| Disassemble Binary File… | Opens a binary as a listing |

With the path set, the hover on an instruction also ends with that region
drawing.

The platform passed to gentool is `intelEuAsm.gentool.platform`, or when that
is empty one chosen from `intelEuAsm.generation` (`ptl` for the default `xe3`).
It has to match where the dump came from: a Xe3 listing does not validate as
`nvl`, which this Mesa treats as Xe3P.

A "Beside" view has the same line numbers as the listing it was made from:
each instruction is re-printed on its own line and everything else (header,
comments, labels, blank lines) is kept in place. The two editors scroll
together until one is closed. Folding lines in one of them, or editing either,
breaks the correspondence.

The "Beside" views are produced by assembling the text and disassembling the
result, so they show gentool's encoding of the listing, not the driver's
bytes. They lose compaction, and with the Mesa build tested they differ from
the original in three more ways: `send.ugm` gains `ExBSO`, a `dpas` and the
last source of a SIMD32 three-source instruction gain a `<0>` region, and a
pipe letter that shares its braces with a token (`{I@2,$6.src}`) is dropped,
because the encoding does not carry it.

## Build and install

Node.js 24 is required (`nvm use` reads `.nvmrc`).

```sh
npm install
npm run package                                   # writes intel-mesa-asm-<version>.vsix
code --install-extension intel-mesa-asm-*.vsix
```

For development, open the folder in VS Code and press F5: it builds, then
opens a second window with the extension loaded and a sample listing in it.

A file is recognised when its first line starts with `Native code for`, or when
it is named `*.euasm`. For anything else, such as a `gentool` case file or a
log with the dump further down, pick **Intel EU Assembly (Mesa)** from the
language selector in the status bar, or add an association:

```json
"files.associations": { "**/plans/**/*.asm": "intel-eu-asm" }
```

## Test

```sh
npm test
```

This type-checks, then runs two suites over the corpus in
[test/corpus/](test/corpus/):

- the grammar test, which tokenizes every line with the TextMate engine VS Code
  uses and fails if an instruction is not recognised or operand text is left
  uncoloured (`EXTRA_CORPUS=<dir>` adds every `*.asm` under a directory);
- the parser tests, which check that every corpus line parses completely, and
  check fields, spans, folding, references and error attachment on specific
  inputs;
- the hover tests, which check that every send in the corpus decodes to the
  message name and lengths Mesa printed in its comment, that every Mesa opcode
  has a description, and the content of specific hovers;
- the gentool tests, which assemble each sample listing, disassemble the result
  and compare it with the original, and check that gentool's errors land on
  the right lines. They need a gentool binary and are skipped without one:
  `GENTOOL=<path> npm test` (`GENTOOL_PLATFORM` overrides `ptl`);
- the format tests, which check that `printer` mode reproduces Mesa's spacing
  on every corpus line, and that aligning changes only whitespace, is stable
  when repeated, and can be undone.

The VS Code providers themselves are thin adapters and have no automated test
yet.

## Why

A compute shader dump is thousands of lines of fixed-column text in which the
interesting information is implicit: a missing `:type` means `:ud`, `<0>` is a
scalar broadcast, `{I@2,$11.src}` is a dependency on two earlier instructions,
and a send's meaning is packed into two hex descriptors. Reading one today
means keeping the printer's rules in your head. The extension puts those rules
in the editor.

## Planned features

| Feature | What it does | Milestone |
|---|---|---|
| Syntax colouring | Distinct colours for opcodes, registers, types, regions, immediates, predicates, scoreboard annotations, labels and send comments | M1 |
| Structure | Outline of shaders and labels, folding of shaders and loops, go-to-definition on `L0`, highlight of every use of a register or SBID token | M2 |
| Column alignment | Re-align operand columns where the printer overflowed them (long `bfn.(…)` opcodes, translated sends) | M3 |
| Hover assistance | Opcode semantics, the full form of an abbreviated operand, decoded immediates, scoreboard explanations, send descriptor decode | M4 |
| `gentool` bridge | Assemble, disassemble and draw register-region diagrams by calling Mesa's `gentool` | M5 |
| Simulator back end | Step through a listing against a simulator and inspect register state | M6 |

See [docs/roadmap.md](docs/roadmap.md) for what each milestone contains and
when it counts as done.

## Documentation

| Document | Contents |
|---|---|
| [docs/dump-format.md](docs/dump-format.md) | The text the extension has to understand: file kinds, line kinds, token classes, and where each is defined in Mesa |
| [docs/architecture.md](docs/architecture.md) | How the extension is put together: grammar, parser, providers, formatter, back-end bridge, and the repository layout |
| [docs/roadmap.md](docs/roadmap.md) | Milestones, exit criteria, and open questions |

## Repository layout

```
package.json                 manifest, language registration, build scripts
language-configuration.json  comments, brackets, word pattern
syntaxes/                    TextMate grammar
src/parser/                  text to document model (no VS Code dependency)
src/analysis/                folding and reference queries over the model
src/format/                  column alignment
src/hover/                   hover text, send descriptor decoding, opcode descriptions
src/backend/gentool.ts       runs gentool and reads its output
src/commands.ts              the gentool commands
src/extension.ts             VS Code providers
test/                        tests, Mesa's case files and two sample listings
docs/                        design documents
data/opcodes.json            Mesa's opcode list, generated
tools/gen-opcodes.py         regenerates it from a Mesa checkout
```

## Requirements

- VS Code 1.90 or newer.
- Node.js 24 and npm to build and test.
- A Mesa build that includes `gentool`, for the gentool commands only.
  Everything else works on plain text dumps with no Mesa checkout.

## Relation to Mesa

The dump syntax is defined by Mesa's printer and parser in
`src/intel/compiler/gen/` (`gen_print.cpp`, `gen_parse.cpp`, `gen_names.c`).
This extension follows that code; where the two disagree, Mesa is right and the
extension has a bug. It does not modify or vendor Mesa.

## License

MIT; see [LICENSE](LICENSE). Parts derive from Mesa, also MIT; see
[NOTICE](NOTICE).
