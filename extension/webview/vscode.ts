/**
 * VS Code webview API singleton.
 *
 * `acquireVsCodeApi()` can only be called ONCE per webview; multiple calls
 * throw. React's StrictMode / re-mounts make it easy to trip that, so we
 * cache the result here.
 */

import type { HostToWebviewMsg, WebviewToHostMsg } from '../src/protocol.js';

interface VsCodeApi {
  postMessage(msg: WebviewToHostMsg): void;
  getState<T = unknown>(): T | undefined;
  setState<T>(state: T): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

let cached: VsCodeApi | null = null;

export function getVsCode(): VsCodeApi {
  if (!cached) cached = acquireVsCodeApi();
  return cached;
}

export function post(msg: WebviewToHostMsg): void {
  getVsCode().postMessage(msg);
}

export type Listener = (msg: HostToWebviewMsg) => void;

const listeners = new Set<Listener>();

window.addEventListener('message', e => {
  const msg = e.data as HostToWebviewMsg;
  for (const l of listeners) l(msg);
});

export function subscribe(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
