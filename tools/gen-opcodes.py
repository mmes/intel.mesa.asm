#!/usr/bin/env python3
"""Writes data/opcodes.json from a Mesa checkout's gen_opcodes.py.

Usage: tools/gen-opcodes.py /path/to/mesa [commit]

The commit is recorded in the output; it defaults to the checkout's HEAD.
"""

import json
import pathlib
import subprocess
import sys

mesa = pathlib.Path(sys.argv[1])
gen = mesa / 'src/intel/compiler/gen'
sys.path.insert(0, str(gen))
import gen_opcodes  # noqa: E402

commit = sys.argv[2] if len(sys.argv) > 2 else subprocess.run(
    ['git', '-C', str(mesa), 'rev-parse', 'HEAD'],
    capture_output=True, text=True, check=True).stdout.strip()

opcodes = [{
    'name': op.name,
    'format': op.format.removeprefix('GEN_FORMAT_').lower(),
    'sources': op.num_srcs,
    'has_dst': not (op.props & gen_opcodes.Props.NO_DST),
    'hw_opcode': op.hw_opcode,
} for op in gen_opcodes.OPCODES]

out = pathlib.Path(__file__).resolve().parent.parent / 'data/opcodes.json'
out.write_text(json.dumps({'mesa_commit': commit, 'opcodes': opcodes}, indent=1) + '\n')
print(f'{len(opcodes)} opcodes -> {out}')
