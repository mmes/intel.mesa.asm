// Tokenizes the corpus with the real TextMate engine and checks that the
// grammar classifies every line and leaves no operand text uncoloured.
//
// Run with `npm test`. The engine comes from the dev dependencies, or from a
// VS Code install when those are missing.

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const GRAMMAR = path.join(ROOT, 'syntaxes', 'intel-eu-asm.tmLanguage.json');
const CORPUS = path.join(__dirname, 'corpus');
const VSCODE_APP = process.env.VSCODE_APP || '/usr/share/code/resources/app';

function load(name) {
  try {
    return require(name);
  } catch {
    return require(path.join(VSCODE_APP, 'node_modules.asar', name));
  }
}

function findOnigWasm() {
  const candidates = [
    path.join(ROOT, 'node_modules', 'vscode-oniguruma', 'release', 'onig.wasm'),
    path.join(VSCODE_APP, 'node_modules.asar.unpacked', 'vscode-oniguruma', 'release', 'onig.wasm'),
    path.join(VSCODE_APP, 'node_modules', 'vscode-oniguruma', 'release', 'onig.wasm'),
  ];
  const found = candidates.find((p) => fs.existsSync(p));
  if (!found) throw new Error('onig.wasm not found; set VSCODE_APP');
  return found;
}

// Text that may stay unscoped inside an instruction: brackets and separators
// of indirect operands and translated sends.
const PLAIN = /^[\s\[\](),+|]*$/;

function kindOf(tokens) {
  const scopes = tokens.flatMap((t) => t.scopes);
  if (scopes.some((s) => s.startsWith('meta.instruction'))) return 'instruction';
  if (scopes.some((s) => s.startsWith('markup.heading.shader'))) return 'header';
  if (scopes.some((s) => s.startsWith('meta.stats'))) return 'stats';
  if (scopes.some((s) => s.startsWith('entity.name.label.definition'))) return 'label';
  if (scopes.some((s) => s.startsWith('invalid.illegal'))) return 'error';
  if (scopes.some((s) => s.startsWith('comment.line'))) return 'comment';
  return 'none';
}

async function main() {
  const vsctm = load('vscode-textmate');
  const oniguruma = load('vscode-oniguruma');
  const wasm = fs.readFileSync(findOnigWasm());
  await oniguruma.loadWASM(wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength));

  const registry = new vsctm.Registry({
    onigLib: Promise.resolve({
      createOnigScanner: (patterns) => new oniguruma.OnigScanner(patterns),
      createOnigString: (s) => new oniguruma.OnigString(s),
    }),
    loadGrammar: async () => vsctm.parseRawGrammar(fs.readFileSync(GRAMMAR, 'utf8'), GRAMMAR),
  });
  const grammar = await registry.loadGrammar('source.intel-eu-asm');

  const files = [];
  for (const dir of ['mesa', 'samples']) {
    for (const f of fs.readdirSync(path.join(CORPUS, dir)).sort()) {
      if (/\.(txt|asm)$/.test(f)) files.push(path.join(CORPUS, dir, f));
    }
  }
  // Extra dumps outside the repository, e.g. EXTRA_CORPUS=~/plans
  if (process.env.EXTRA_CORPUS) {
    const walk = (d) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.name.endsWith('.asm')) files.push(p);
      }
    };
    walk(process.env.EXTRA_CORPUS);
  }

  const failures = [];
  const seen = new Set();
  const fail = (file, n, why, line) => {
    // Report each distinct problem once; one grammar gap hits many lines.
    const key = why.replace(/\d+/g, 'N');
    if (seen.has(key)) return;
    seen.add(key);
    if (failures.length < 40) failures.push(`${path.relative(ROOT, file)}:${n}: ${why}\n    ${line}`);
    else if (failures.length === 40) failures.push('... more failures suppressed');
  };
  const totals = { files: files.length, lines: 0, instruction: 0, header: 0, stats: 0, label: 0, error: 0, comment: 0, none: 0 };

  for (const file of files) {
    const isCaseFile = file.endsWith('.txt');
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    let ruleStack = vsctm.INITIAL;
    lines.forEach((line, i) => {
      const r = grammar.tokenizeLine(line, ruleStack);
      ruleStack = r.ruleStack;
      if (!line.trim()) return;
      totals.lines++;
      const kind = kindOf(r.tokens);
      totals[kind]++;

      if (isCaseFile && kind !== 'instruction') fail(file, i + 1, `case line classified as ${kind}`, line);
      if (!isCaseFile && kind === 'none') fail(file, i + 1, 'line not classified', line);

      if (kind === 'instruction') {
        for (const t of r.tokens) {
          const text = line.slice(t.startIndex, t.endIndex);
          const bare = t.scopes.every((s) => s === 'source.intel-eu-asm' || s.startsWith('meta.'));
          if (bare && !PLAIN.test(text)) fail(file, i + 1, `unscoped text ${JSON.stringify(text)}`, line);
        }
      }
    });
    if (ruleStack.depth !== 1) {
      fail(file, lines.length, 'grammar state leaked past end of file', '');
    }
  }

  console.log(Object.entries(totals).map(([k, v]) => `${k}=${v}`).join(' '));
  if (failures.length) {
    console.log(`\nFAIL (${failures.length})\n` + failures.join('\n'));
    process.exit(1);
  }
  console.log('PASS');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
