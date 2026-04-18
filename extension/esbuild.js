/**
 * esbuild orchestrator for the fineCode VS Code extension.
 *
 * Two bundles:
 *   1. extension.js — runs in the VS Code Extension Host (Node.js, CJS)
 *      Bundles everything except `vscode` (provided at runtime) and native
 *      MCP stdio deps that must stay external.
 *   2. webview.js — runs in the Webview (browser, ESM-ish via IIFE)
 *      Bundles React + our Chat UI into a single self-contained script.
 *
 * The core of fineCode (../src/**) is ESM with explicit .js extensions on
 * imports. esbuild understands that convention natively, so we just point
 * the entry points at our extension sources and it walks the graph.
 */

const esbuild = require('esbuild');
const path = require('node:path');

const watch = process.argv.includes('--watch');

/** @type {import('esbuild').BuildOptions} */
const extensionConfig = {
  entryPoints: [path.join(__dirname, 'src', 'extension.ts')],
  bundle: true,
  outfile: path.join(__dirname, 'dist', 'extension.js'),
  platform: 'node',
  target: 'node18',
  format: 'cjs',
  sourcemap: true,
  // `vscode` is resolved at runtime by the Extension Host, must stay external.
  // The node builtins used by our core (fs, path, child_process, ...) are
  // handled automatically by platform:node.
  external: ['vscode'],
  // Our core uses ESM with explicit .js extensions (e.g. `from './Agent.js'`).
  // esbuild's default resolver handles that correctly when bundling.
  logLevel: 'info',
  // Allow importing from the parent src/ via relative paths.
  resolveExtensions: ['.ts', '.tsx', '.js', '.json'],
  // Minify in release builds; keep readable in dev for stack traces.
  minify: false,
};

/** @type {import('esbuild').BuildOptions} */
const webviewConfig = {
  entryPoints: [path.join(__dirname, 'webview', 'main.tsx')],
  bundle: true,
  outfile: path.join(__dirname, 'dist', 'webview.js'),
  platform: 'browser',
  target: 'es2020',
  format: 'iife',
  sourcemap: true,
  jsx: 'automatic',
  logLevel: 'info',
  loader: {
    '.css': 'text',
  },
  minify: false,
};

async function run() {
  if (watch) {
    const extCtx = await esbuild.context(extensionConfig);
    const webCtx = await esbuild.context(webviewConfig);
    await Promise.all([extCtx.watch(), webCtx.watch()]);
    console.log('fineCode: watching for changes...');
  } else {
    await Promise.all([esbuild.build(extensionConfig), esbuild.build(webviewConfig)]);
    console.log('fineCode: build complete.');
  }
}

run().catch(err => {
  console.error(err);
  process.exit(1);
});
