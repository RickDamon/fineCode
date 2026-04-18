/**
 * fineCode VS Code extension entry.
 *
 * Contributes a Chat webview in the activity bar, plus a handful of commands.
 * The heavy lifting lives in AgentBridge — this file is strictly glue.
 */

import * as vscode from 'vscode';
import * as path from 'node:path';
import * as fs from 'node:fs';

import { AgentBridge } from './agentBridge.js';
import { configFile } from '../../src/config/paths.js';

const VIEW_ID = 'fineCode.chat';

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel('fineCode');
  context.subscriptions.push(output);

  const provider = new ChatViewProvider(context, output);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(VIEW_ID, provider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('fineCode.open', async () => {
      await vscode.commands.executeCommand('workbench.view.extension.fineCode');
    }),
    vscode.commands.registerCommand('fineCode.newSession', async () => {
      await provider.reset({ continueLatest: false });
    }),
    vscode.commands.registerCommand('fineCode.continueSession', async () => {
      await provider.reset({ continueLatest: true });
    }),
    vscode.commands.registerCommand('fineCode.openConfig', async () => {
      const cf = configFile();
      if (!fs.existsSync(cf)) {
        const choice = await vscode.window.showInformationMessage(
          `Config file not found at ${cf}. Create an empty one?`,
          'Create',
          'Cancel',
        );
        if (choice !== 'Create') return;
        fs.mkdirSync(path.dirname(cf), { recursive: true, mode: 0o700 });
        fs.writeFileSync(cf, '{}\n', { mode: 0o600 });
      }
      const doc = await vscode.workspace.openTextDocument(cf);
      await vscode.window.showTextDocument(doc);
    }),
  );

  output.appendLine('fineCode activated.');
}

export function deactivate(): void {
  // Nothing to do; AgentBridge dispose is wired to view disposal.
}

/**
 * Provides the sidebar chat view. Re-creates the AgentBridge every time the
 * view is (re-)resolved — VS Code fires this each time the view becomes
 * visible fresh, or if the user clicks the Refresh button of a custom view.
 *
 * With `retainContextWhenHidden: true` (see activate) the webview state
 * persists when the sidebar is collapsed/hidden, so we DON'T want to tear
 * down between hide/show — we only rebuild when `resolveWebviewView` is
 * called for the first time, OR when the user explicitly triggers reset.
 */
class ChatViewProvider implements vscode.WebviewViewProvider {
  private bridge: AgentBridge | null = null;
  private view: vscode.WebviewView | null = null;
  private readonly ctx: vscode.ExtensionContext;
  private readonly output: vscode.OutputChannel;

  constructor(ctx: vscode.ExtensionContext, output: vscode.OutputChannel) {
    this.ctx = ctx;
    this.output = output;
  }

  async resolveWebviewView(webviewView: vscode.WebviewView): Promise<void> {
    this.view = webviewView;

    const distUri = vscode.Uri.joinPath(this.ctx.extensionUri, 'dist');
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [distUri, vscode.Uri.joinPath(this.ctx.extensionUri, 'webview')],
    };

    webviewView.webview.html = this.renderHtml(webviewView.webview);

    webviewView.onDidDispose(() => {
      this.bridge?.dispose();
      this.bridge = null;
      this.view = null;
    });

    const cwd = resolveCwd();
    await this.buildBridge(cwd, { continueLatest: false });
  }

  /** Rebuild the agent (used for newSession / continueSession commands). */
  async reset(opts: { continueLatest: boolean }): Promise<void> {
    if (!this.view) {
      // No view yet — open it first.
      await vscode.commands.executeCommand('workbench.view.extension.fineCode');
      // resolveWebviewView will fire; we can't distinguish new-vs-continue
      // from here unless we stash it. Keep simple: swap after open.
      setTimeout(() => void this.reset(opts), 200);
      return;
    }
    this.bridge?.dispose();
    const cwd = resolveCwd();
    await this.buildBridge(cwd, opts);
  }

  private async buildBridge(cwd: string, opts: { continueLatest: boolean }): Promise<void> {
    const bridge = new AgentBridge(this.ctx, cwd, this.output);
    try {
      await bridge.initialize({ continueLatest: opts.continueLatest });
    } catch (err) {
      const msg = (err as Error).message;
      vscode.window.showErrorMessage(`fineCode: ${msg}`);
      this.output.appendLine(`[fineCode] init failed: ${msg}`);
      // Still attach so the webview can render an error state.
    }
    if (this.view) bridge.attach(this.view.webview);
    this.bridge = bridge;
  }

  private renderHtml(webview: vscode.Webview): string {
    const nonce = getNonce();
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.ctx.extensionUri, 'dist', 'webview.js'),
    );
    const cspSource = webview.cspSource;

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'; img-src ${cspSource} data:; font-src ${cspSource};">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>fineCode</title>
<style>
  html, body { height: 100%; margin: 0; padding: 0; }
  body {
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size);
    color: var(--vscode-foreground);
    background: var(--vscode-sideBar-background);
  }
  #root { height: 100%; display: flex; }
</style>
</head>
<body>
<div id="root"></div>
<script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}

function resolveCwd(): string {
  const folders = vscode.workspace.workspaceFolders;
  if (folders && folders.length > 0) return folders[0]!.uri.fsPath;
  return process.cwd();
}

function getNonce(): string {
  let text = '';
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) text += chars.charAt(Math.floor(Math.random() * chars.length));
  return text;
}
