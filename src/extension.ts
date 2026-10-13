import * as vscode from 'vscode';
import { foldingRanges } from './analysis/folding.ts';
import { regionsForHover, registerGentool, type Documents } from './commands.ts';
import { alignColumns, type FormatOptions } from './format/align.ts';
import { definitionAt, occurrences, targetAt, type Occurrence } from './analysis/references.ts';
import { hoverAt } from './hover/hover.ts';
import type { ParsedDocument, Span } from './parser/model.ts';
import { GENERATIONS, type Generation } from './platform.ts';
import { parseDocument } from './parser/parse.ts';

const LANGUAGE = 'intel-eu-asm';
const DIAGNOSTICS_DELAY_MS = 300;

// One parse per document version, shared by every provider.
const cache = new Map<string, { version: number; parsed: ParsedDocument }>();

function parsed(document: vscode.TextDocument): ParsedDocument {
  const key = document.uri.toString();
  const hit = cache.get(key);
  if (hit?.version === document.version) return hit.parsed;
  const result = parseDocument(document.getText().split(/\r?\n/));
  cache.set(key, { version: document.version, parsed: result });
  return result;
}

const toRange = (s: Span) => new vscode.Range(s.line, s.start, s.line, s.end);

function occurrencesAt(document: vscode.TextDocument, position: vscode.Position): Occurrence[] {
  const target = targetAt(parsed(document), position.line, position.character);
  return target ? occurrences(target) : [];
}

function generationOf(document: vscode.TextDocument): Generation {
  const value = vscode.workspace.getConfiguration('intelEuAsm', document).get<string>('generation', 'xe3');
  return GENERATIONS.find((g) => g === value) ?? 'xe3';
}

const symbols: vscode.DocumentSymbolProvider = {
  provideDocumentSymbols(document) {
    return parsed(document).shaders.map((shader) => {
      // `unnamed compute shader  (src_hash 0x…) (blake3 …)`: the hashes go in the detail.
      const paren = shader.name.indexOf(' (');
      const name = (paren > 0 ? shader.name.slice(0, paren) : shader.name).trim();
      const hash = /src_hash (0x[0-9a-f]+)/.exec(shader.name)?.[1];
      const detail = [shader.summary, hash].filter(Boolean).join(', ');
      const start = document.lineAt(shader.startLine).range;
      const symbol = new vscode.DocumentSymbol(
        name, detail, vscode.SymbolKind.Function,
        new vscode.Range(start.start, document.lineAt(shader.endLine).range.end), start);

      const loopHeads = new Set(
        shader.instructions.filter((i) => i.opcode.name === 'while').flatMap((i) => i.labels.map((l) => l.name)));
      for (const label of shader.labels.values()) {
        const range = toRange(label.span);
        symbol.children.push(new vscode.DocumentSymbol(
          label.name, loopHeads.has(label.name) ? 'loop' : '', vscode.SymbolKind.Key, range, range));
      }
      return symbol;
    });
  },
};

const folding: vscode.FoldingRangeProvider = {
  provideFoldingRanges(document) {
    return foldingRanges(parsed(document)).map((f) => new vscode.FoldingRange(f.start, f.end));
  },
};

const definitions: vscode.DefinitionProvider = {
  provideDefinition(document, position) {
    const span = definitionAt(parsed(document), position.line, position.character, generationOf(document));
    return span && new vscode.Location(document.uri, toRange(span));
  },
};

const references: vscode.ReferenceProvider = {
  provideReferences(document, position, context) {
    return occurrencesAt(document, position)
      .filter((o) => context.includeDeclaration || o.access === 'read')
      .map((o) => new vscode.Location(document.uri, toRange(o.span)));
  },
};

const highlights: vscode.DocumentHighlightProvider = {
  provideDocumentHighlights(document, position) {
    return occurrencesAt(document, position).map((o) => new vscode.DocumentHighlight(
      toRange(o.span),
      o.access === 'write' ? vscode.DocumentHighlightKind.Write : vscode.DocumentHighlightKind.Read));
  },
};

const documents: Documents = { language: LANGUAGE, parsed, generationOf };

const hovers: vscode.HoverProvider = {
  async provideHover(document, position) {
    const result = hoverAt({
      lines: document.getText().split(/\r?\n/),
      doc: parsed(document),
      generation: generationOf(document),
      link: (line) => document.uri.with({ fragment: `L${line + 1}` }).toString(),
    }, position.line, position.character);
    if (!result) return undefined;
    // With gentool configured, instruction hovers also get its drawing of the bytes touched.
    const inst = parsed(document).instructionAt[position.line];
    const onInstruction = inst && position.character >= inst.opcode.span.start
      && position.character <= (inst.options?.start ?? inst.comment?.start ?? Infinity);
    const diagram = onInstruction ? await regionsForHover(documents, document, position.line) : undefined;
    const markdown = diagram ? `${result.markdown}\n\n**Register bytes** (gentool)\n\n\`\`\`text\n${diagram}\n\`\`\`` : result.markdown;
    return new vscode.Hover(new vscode.MarkdownString(markdown), toRange(result.span));
  },
};

function formatOptions(document: vscode.TextDocument): FormatOptions {
  const config = vscode.workspace.getConfiguration('intelEuAsm.format', document);
  return {
    columns: config.get('columns', 'aligned'),
    maxOverflow: config.get('maxOverflow', 12),
    alignComments: config.get('alignComments', true),
  };
}

function format(document: vscode.TextDocument, range?: vscode.Range): vscode.TextEdit[] {
  const lines = document.getText().split(/\r?\n/);
  const within = range && { start: range.start.line, end: range.end.line };
  return alignColumns(lines, parsed(document), formatOptions(document), within).map((edit) =>
    vscode.TextEdit.replace(new vscode.Range(edit.line, 0, edit.line, lines[edit.line].length), edit.text));
}

const formatting: vscode.DocumentFormattingEditProvider & vscode.DocumentRangeFormattingEditProvider = {
  provideDocumentFormattingEdits: (document) => format(document),
  provideDocumentRangeFormattingEdits: (document, range) => format(document, range),
};

export function activate(context: vscode.ExtensionContext): void {
  const selector: vscode.DocumentSelector = { language: LANGUAGE };
  const diagnostics = vscode.languages.createDiagnosticCollection(LANGUAGE);
  const pending = new Map<string, ReturnType<typeof setTimeout>>();

  // Validator errors are printed under the instruction they reject; show them on it.
  const refresh = (document: vscode.TextDocument) => {
    if (document.languageId !== LANGUAGE) {
      diagnostics.delete(document.uri);
      return;
    }
    const found: vscode.Diagnostic[] = [];
    for (const shader of parsed(document).shaders) {
      for (const inst of shader.instructions) {
        for (const error of inst.errors) {
          const diagnostic = new vscode.Diagnostic(
            document.lineAt(inst.line).range, error.message, vscode.DiagnosticSeverity.Error);
          diagnostic.source = 'EU validator';
          found.push(diagnostic);
        }
      }
    }
    diagnostics.set(document.uri, found);
  };

  const schedule = (document: vscode.TextDocument) => {
    const key = document.uri.toString();
    clearTimeout(pending.get(key));
    pending.set(key, setTimeout(() => {
      pending.delete(key);
      refresh(document);
    }, DIAGNOSTICS_DELAY_MS));
  };

  context.subscriptions.push(
    diagnostics,
    vscode.languages.registerDocumentSymbolProvider(selector, symbols),
    vscode.languages.registerFoldingRangeProvider(selector, folding),
    vscode.languages.registerDefinitionProvider(selector, definitions),
    vscode.languages.registerReferenceProvider(selector, references),
    vscode.languages.registerDocumentHighlightProvider(selector, highlights),
    vscode.languages.registerHoverProvider(selector, hovers),
    vscode.languages.registerDocumentFormattingEditProvider(selector, formatting),
    vscode.languages.registerDocumentRangeFormattingEditProvider(selector, formatting),
    vscode.workspace.onDidOpenTextDocument(refresh),
    vscode.workspace.onDidChangeTextDocument((e) => schedule(e.document)),
    vscode.workspace.onDidCloseTextDocument((document) => {
      const key = document.uri.toString();
      clearTimeout(pending.get(key));
      pending.delete(key);
      cache.delete(key);
      diagnostics.delete(document.uri);
    }),
  );
  registerGentool(context, documents);
  vscode.workspace.textDocuments.forEach(refresh);
}

export function deactivate(): void {
  cache.clear();
}
