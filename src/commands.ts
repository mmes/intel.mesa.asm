// Commands and diagnostics that need Mesa's gentool. A command run before
// `intelEuAsm.gentool.path` is set offers to set it.

import * as vscode from 'vscode';
import {
  assemble, DEFAULT_PLATFORM, disassemble, GentoolError, instructionText, overlayDisassembly, regionDiagram,
  type DisassemblyOptions, type Gentool,
} from './backend/gentool.ts';
import type { ParsedDocument, Shader } from './parser/model.ts';
import { shaderAt } from './parser/parse.ts';
import type { Generation } from './platform.ts';

export interface Documents {
  language: string;
  parsed(document: vscode.TextDocument): ParsedDocument;
  generationOf(document: vscode.TextDocument): Generation;
}

/** The configured gentool, or undefined when no path is set. */
export function gentoolFor(documents: Documents, document?: vscode.TextDocument): Gentool | undefined {
  const config = vscode.workspace.getConfiguration('intelEuAsm.gentool', document);
  const path = config.get<string>('path', '').trim();
  if (!path) return undefined;
  const generation = document ? documents.generationOf(document) : 'xe3';
  return { path, platform: config.get<string>('platform', '').trim() || DEFAULT_PLATFORM[generation] };
}

/** Asks for the gentool binary with a file dialog and saves it in the user settings. */
async function selectGentool(): Promise<boolean> {
  const picked = await vscode.window.showOpenDialog({
    canSelectMany: false,
    title: 'Select Mesa\'s gentool binary (<build>/src/intel/compiler/gen/gentool)',
    openLabel: 'Use as gentool',
  });
  if (!picked?.[0]) return false;
  await vscode.workspace.getConfiguration('intelEuAsm.gentool')
    .update('path', picked[0].fsPath, vscode.ConfigurationTarget.Global);
  return true;
}

async function requireGentool(documents: Documents, document?: vscode.TextDocument): Promise<Gentool | undefined> {
  const tool = gentoolFor(documents, document);
  if (tool) return tool;
  const browse = 'Select gentool…';
  const open = 'Open Settings';
  const choice = await vscode.window.showErrorMessage(
    'This command needs Mesa\'s gentool, and its path is not set (intelEuAsm.gentool.path).', browse, open);
  if (choice === open) await vscode.commands.executeCommand('workbench.action.openSettings', 'intelEuAsm.gentool.path');
  if (choice === browse && await selectGentool()) return gentoolFor(documents, document);
  return undefined;
}

async function report(error: unknown): Promise<void> {
  const message = error instanceof GentoolError ? error.message : `gentool: ${String(error)}`;
  await vscode.window.showErrorMessage(message);
}

const regionCache = new Map<string, string | undefined>();

/** The region diagram for the instruction on a line, for the hover. Never throws; absent when gentool is not set up or cannot draw it. */
export async function regionsForHover(
  documents: Documents, document: vscode.TextDocument, line: number,
): Promise<string | undefined> {
  const tool = gentoolFor(documents, document);
  if (!tool) return undefined;
  const text = instructionText(document.getText().split(/\r?\n/), documents.parsed(document), line);
  if (!text) return undefined;
  const key = `${tool.path}\0${tool.platform}\0${text}`;
  if (!regionCache.has(key)) {
    try {
      regionCache.set(key, await regionDiagram(tool, text));
    } catch {
      return undefined;
    }
  }
  return regionCache.get(key);
}

export function registerGentool(context: vscode.ExtensionContext, documents: Documents): void {
  const diagnostics = vscode.languages.createDiagnosticCollection('gentool');
  const output = vscode.window.createOutputChannel('Intel EU Assembly');

  const active = (): vscode.TextEditor | undefined => {
    const editor = vscode.window.activeTextEditor;
    if (editor?.document.languageId === documents.language) return editor;
    void vscode.window.showErrorMessage('Open an Intel EU assembly listing first.');
    return undefined;
  };

  /**
   * Assembles each shader of a document separately, since labels restart in
   * each. Errors go to the Problems panel; the binaries come back only when
   * every shader assembled.
   */
  const assembleAll = async (document: vscode.TextDocument, tool: Gentool) => {
    const lines = document.getText().split(/\r?\n/);
    const parsed = documents.parsed(document);
    const found: vscode.Diagnostic[] = [];
    const binaries: { shader: Shader; binary: Buffer }[] = [];
    for (const shader of parsed.shaders) {
      if (!shader.instructions.length) continue;
      const result = await assemble(tool, lines, parsed, shader);
      for (const error of result.errors) {
        const diagnostic = new vscode.Diagnostic(
          document.lineAt(Math.min(error.line, document.lineCount - 1)).range, error.message, vscode.DiagnosticSeverity.Error);
        diagnostic.source = `gentool (${tool.platform})`;
        found.push(diagnostic);
      }
      if (result.binary) {
        binaries.push({ shader, binary: result.binary });
      }
    }
    diagnostics.set(document.uri, found);
    if (found.length) {
      void vscode.window.showWarningMessage(
        `gentool (${tool.platform}) reported ${found.length} problem${found.length === 1 ? '' : 's'}. See the Problems panel.`);
      return undefined;
    }
    return binaries;
  };

  const check = async () => {
    const editor = active();
    const tool = editor && await requireGentool(documents, editor.document);
    if (!editor || !tool) return;
    const binaries = await assembleAll(editor.document, tool);
    if (!binaries) return;
    const bytes = binaries.reduce((sum, b) => sum + b.binary.length, 0);
    void vscode.window.showInformationMessage(
      `gentool (${tool.platform}): assembles and validates cleanly, ${bytes} bytes uncompacted.`);
  };

  const assembleToFile = async () => {
    const editor = active();
    const tool = editor && await requireGentool(documents, editor.document);
    if (!editor || !tool) return;
    const binaries = await assembleAll(editor.document, tool);
    if (!binaries) return;
    if (binaries.length !== 1) {
      void vscode.window.showErrorMessage(
        `This file has ${binaries.length} shaders. A binary holds one; select a file with a single shader.`);
      return;
    }
    const target = await vscode.window.showSaveDialog({
      defaultUri: editor.document.uri.with({ path: editor.document.uri.path.replace(/(\.[^./]*)?$/, '.bin') }),
      filters: { 'EU binary': ['bin'] },
    });
    if (target) await vscode.workspace.fs.writeFile(target, binaries[0].binary);
  };

  const showListing = async (text: string): Promise<vscode.TextEditor> => {
    const document = await vscode.workspace.openTextDocument({ language: documents.language, content: text });
    return vscode.window.showTextDocument(document, { viewColumn: vscode.ViewColumn.Beside, preview: false });
  };

  // Pairs of editors that scroll together: a listing and a re-print of it with the same line count.
  const scrollPartner = new Map<string, string>();
  // A reveal we made comes back as a scroll event from the partner; ignore those for a moment.
  const quietUntil = new Map<string, number>();
  const SCROLL_ECHO_MS = 200;

  const lockScrolling = (a: vscode.TextEditor, b: vscode.TextEditor) => {
    const [keyA, keyB] = [a.document.uri.toString(), b.document.uri.toString()];
    // A listing follows only its newest re-print.
    const previous = scrollPartner.get(keyA);
    if (previous) scrollPartner.delete(previous);
    scrollPartner.set(keyA, keyB);
    scrollPartner.set(keyB, keyA);
    const top = a.visibleRanges[0]?.start.line ?? 0;
    quietUntil.set(keyB, Date.now() + SCROLL_ECHO_MS);
    b.revealRange(new vscode.Range(top, 0, top, 0), vscode.TextEditorRevealType.AtTop);
  };

  const followScroll = (event: vscode.TextEditorVisibleRangesChangeEvent) => {
    const key = event.textEditor.document.uri.toString();
    const partner = scrollPartner.get(key);
    const top = event.visibleRanges[0]?.start.line;
    if (!partner || top === undefined || Date.now() < (quietUntil.get(key) ?? 0)) return;
    for (const other of vscode.window.visibleTextEditors) {
      if (other.document.uri.toString() !== partner || other.visibleRanges[0]?.start.line === top) continue;
      quietUntil.set(partner, Date.now() + SCROLL_ECHO_MS);
      other.revealRange(new vscode.Range(top, 0, top, 0), vscode.TextEditorRevealType.AtTop);
    }
  };

  const unlockScrolling = (document: vscode.TextDocument) => {
    const key = document.uri.toString();
    const partner = scrollPartner.get(key);
    if (partner) scrollPartner.delete(partner);
    scrollPartner.delete(key);
    quietUntil.delete(key);
  };

  // Re-prints the current listing in another of gentool's forms, by assembling it and disassembling the result.
  const reprint = (options: DisassemblyOptions) => async () => {
    const editor = active();
    const tool = editor && await requireGentool(documents, editor.document);
    if (!editor || !tool) return;
    const binaries = await assembleAll(editor.document, tool);
    if (!binaries) return;
    // The listing is gentool's encoding of the text, which is not byte for byte what the driver emitted.
    const note = `// Re-assembled by gentool for ${tool.platform}; not the driver's own encoding (no compaction).`;
    const lines = editor.document.getText().split(/\r?\n/);

    // Each instruction goes back on the line it came from, so the view has the
    // original's line numbers and can scroll with it.
    const aligned = [...lines];
    const plain: string[] = [];
    let matched = true;
    for (const { shader, binary } of binaries) {
      const text = await disassemble(tool, binary, options);
      plain.push((shader.headerLine === undefined ? '' : `${lines[shader.headerLine]}\n`) + text);
      const overlay = overlayDisassembly(lines, shader, text);
      if (overlay) aligned.splice(shader.startLine, overlay.length, ...overlay);
      else matched = false;
    }

    if (matched) {
      const view = await showListing([...aligned, note].join('\n'));
      lockScrolling(editor, view);
    } else {
      await showListing([`${note}\n`, ...plain].join('\n'));
      void vscode.window.showInformationMessage(
        'gentool\'s output did not match the listing instruction for instruction, so the view is not scroll-locked.');
    }
  };

  const disassembleFile = async (uri?: vscode.Uri) => {
    const tool = await requireGentool(documents, vscode.window.activeTextEditor?.document);
    if (!tool) return;
    const source = uri ?? (await vscode.window.showOpenDialog({ canSelectMany: false, title: 'EU binary to disassemble' }))?.[0];
    if (!source) return;
    const binary = Buffer.from(await vscode.workspace.fs.readFile(source));
    await showListing(await disassemble(tool, binary));
  };

  const showRegions = async () => {
    const editor = active();
    const tool = editor && await requireGentool(documents, editor.document);
    if (!editor || !tool) return;
    const line = editor.selection.active.line;
    const lines = editor.document.getText().split(/\r?\n/);
    const text = instructionText(lines, documents.parsed(editor.document), line);
    if (!text || !shaderAt(documents.parsed(editor.document), line)) {
      void vscode.window.showErrorMessage('Put the cursor on an instruction.');
      return;
    }
    const diagram = await regionDiagram(tool, text);
    output.clear();
    output.appendLine(`${text.replace(/\s+/g, ' ')}    (line ${line + 1}, ${tool.platform})`);
    output.appendLine('');
    output.appendLine(diagram ?? 'gentool cannot draw the regions of this instruction.');
    output.show(true);
  };

  const guarded = (run: (...args: never[]) => Promise<void>) => (...args: never[]) => run(...args).catch(report);

  context.subscriptions.push(
    diagnostics, output,
    vscode.commands.registerCommand('intelEuAsm.gentool.check', guarded(check)),
    vscode.commands.registerCommand('intelEuAsm.gentool.assembleToFile', guarded(assembleToFile)),
    vscode.commands.registerCommand('intelEuAsm.gentool.showVerbose', guarded(reprint({ verbose: true }))),
    vscode.commands.registerCommand('intelEuAsm.gentool.showTranslated', guarded(reprint({ translatedSends: true }))),
    vscode.commands.registerCommand('intelEuAsm.gentool.showHex', guarded(reprint({ hex: true }))),
    vscode.commands.registerCommand('intelEuAsm.gentool.disassembleFile', guarded(disassembleFile)),
    vscode.commands.registerCommand('intelEuAsm.gentool.showRegions', guarded(showRegions)),
    vscode.commands.registerCommand('intelEuAsm.gentool.select', guarded(async () => { await selectGentool(); })),
    // gentool's verdict is about the text as it was; drop it once the text changes.
    vscode.workspace.onDidChangeTextDocument((e) => diagnostics.delete(e.document.uri)),
    vscode.workspace.onDidCloseTextDocument((document) => {
      diagnostics.delete(document.uri);
      unlockScrolling(document);
    }),
    vscode.window.onDidChangeTextEditorVisibleRanges(followScroll),
  );
}
