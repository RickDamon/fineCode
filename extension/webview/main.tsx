/**
 * Webview entry. Mounts the React app onto #root.
 *
 * We do NOT use @vscode/webview-ui-toolkit here to keep the bundle tiny —
 * VS Code already exposes theme CSS variables we can use directly, and our
 * UI is simple enough (chat bubbles + input + a dialog) that native elements
 * are cleaner.
 */

import { createRoot } from 'react-dom/client';
import { App } from './App.js';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — esbuild text loader
import cssText from './styles.css';

// Inject the bundled CSS once. We can't use a separate <link> because the
// CSP forbids arbitrary style URLs; we'd need to register every file with
// localResourceRoots. Inlining is simpler.
const style = document.createElement('style');
style.textContent = cssText as unknown as string;
document.head.appendChild(style);

const rootEl = document.getElementById('root');
if (rootEl) {
  createRoot(rootEl).render(<App />);
}
