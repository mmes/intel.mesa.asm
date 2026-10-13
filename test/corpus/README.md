# Test corpus

| Directory | Contents | Source |
|---|---|---|
| `mesa/` | Round-trip case files, one instruction per line with platform and bytes | `src/intel/compiler/gen/tests/` in Mesa at the commit in `mesa/MESA_COMMIT`. MIT licensed, copyright Intel Corporation. |
| `samples/` | Two small shader listings in the form `INTEL_DEBUG=cs` prints | Written by hand for these tests. They are not the output of any real shader. |

`samples/loop.asm` has a loop with loads and stores; `samples/systolic.asm` has
an `if` / `else`, a `dpas`, a block load and a gather send. Both assemble and
validate with `gentool asm -p ptl`.

Not covered yet: non-compute stages, `INTEL_DEBUG=hex` and `ann` output, and
validator `ERROR:` lines from a real compile.
