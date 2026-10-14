# Changelog

## 0.6.2

- The gentool "Beside" views (verbose, translated sends, encoded bytes) now
  keep the original's line numbers: each instruction is re-printed on the line
  it came from, and headers, comments, labels and blank lines stay in place.
- A "Beside" view scrolls together with the listing it was made from.

## 0.6.1

First release.

### Reading a dump

- Syntax colouring for shader dumps printed with `INTEL_DEBUG`, for `gentool
  disasm` output and for Mesa's round-trip case files. Sends, `dpas` and `math`
  get their own bold opcode colour.
- Outline of shaders and their labels, with loop heads marked.
- Folding of shaders, loops, and each arm of an `if` / `else` / `endif`.
- Highlighting of every use of the register, scoreboard token or label under
  the cursor, with writes marked differently from reads. On an opcode, the
  same for every register its operands name.
- Go to Definition on a label, on a register (the last write above), on a
  token wait such as `$5.dst` (the instruction that set it) and on a pipe
  distance such as `I@2` (the instruction it counts back to). Find All
  References on the same.
- Validator `ERROR:` lines shown as problems on the instruction they reject.

### Hovers

- On an opcode: what the instruction does, each operand by role in its full
  form with the registers it covers and where it was last written, masking and
  predication, the pipe it runs in, what its scoreboard annotations wait for
  or who waits on it, and its encoding flags.
- On a send: the message decoded from its descriptors, payload and response
  sizes, and the registers a gather send collects. LSC and gateway messages
  are decoded; other shared functions show the comment Mesa printed.
- On an operand, immediate, annotation, flag, label, predicate or exec size:
  what that one thing means.

### Column alignment

- Format Document and Format Selection re-align the operand columns of each
  shader, changing whitespace only. `intelEuAsm.format.columns: printer`
  restores Mesa's own spacing. Formatting on save is off for this language.

### gentool

- With the path to Mesa's `gentool` set: check a listing by assembling and
  validating it, re-print it in verbose, translated-send or byte-prefixed
  form, draw the register bytes an instruction touches, assemble to a binary
  file and disassemble one.

### Settings

- `intelEuAsm.generation`: the hardware generation a dump is from, which a
  dump does not record. Default `xe3`.
- `intelEuAsm.format.columns`, `intelEuAsm.format.maxOverflow`,
  `intelEuAsm.format.alignComments`.
- `intelEuAsm.gentool.path`, `intelEuAsm.gentool.platform`.

### Known limits

- Pipe-distance links are estimates, counted in file order with Mesa's brw
  pipe rules; the hover says when one looks wrong.
- "Last written" follows only the register an operand names, not the further
  registers a wide operand covers.
- Opcode descriptions have not been checked against the hardware
  specification.
- Listings re-printed through gentool show its encoding of the text, not the
  driver's bytes.
