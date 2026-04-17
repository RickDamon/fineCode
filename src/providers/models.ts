/**
 * Dynamic model listing — query `/v1/models` on OpenAI-compatible endpoints,
 * or use the Anthropic-specific endpoint. Falls back gracefully so the caller
 * can always use a local fallback list.
 */

interface ListOpts {
  /** Base URL (no trailing slash needed). Required. */
  baseUrl: string;
  /** API key; some endpoints (Ollama) accept any non-empty value. */
  apiKey?: string;
  /** Abort timeout in ms. Default 3500. */
  timeoutMs?: number;
  /** "openai" (default) or "anthropic". */
  kind?: 'openai' | 'anthropic';
}

export interface ModelInfo {
  id: string;
  /** Optional display hint (capabilities, owner, etc.) */
  description?: string;
}

/**
 * Try to list models from the provider.
 * Returns `null` on any failure (network, auth, unsupported endpoint).
 * Never throws.
 */
export async function listModels(opts: ListOpts): Promise<ModelInfo[] | null> {
  if (!opts.baseUrl) return null;
  if (typeof fetch !== 'function') return null;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 3500);

  try {
    if (opts.kind === 'anthropic') {
      return await listAnthropicModels(opts, ctrl.signal);
    }
    return await listOpenAICompatModels(opts, ctrl.signal);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function listOpenAICompatModels(
  opts: ListOpts,
  signal: AbortSignal,
): Promise<ModelInfo[] | null> {
  const url = joinUrl(opts.baseUrl, 'models');
  const headers: Record<string, string> = { accept: 'application/json' };
  if (opts.apiKey) headers.authorization = `Bearer ${opts.apiKey}`;

  const res = await fetch(url, { headers, signal });
  if (!res.ok) return null;
  const json = (await res.json()) as { data?: Array<{ id: string; owned_by?: string }> };
  if (!json.data || !Array.isArray(json.data)) return null;
  return json.data
    .filter(m => typeof m.id === 'string')
    .map(m => ({ id: m.id, description: m.owned_by }));
}

async function listAnthropicModels(
  opts: ListOpts,
  signal: AbortSignal,
): Promise<ModelInfo[] | null> {
  const url = joinUrl(opts.baseUrl, 'models');
  const headers: Record<string, string> = {
    accept: 'application/json',
    'anthropic-version': '2023-06-01',
  };
  if (opts.apiKey) headers['x-api-key'] = opts.apiKey;

  const res = await fetch(url, { headers, signal });
  if (!res.ok) return null;
  const json = (await res.json()) as { data?: Array<{ id: string; display_name?: string }> };
  if (!json.data) return null;
  return json.data
    .filter(m => typeof m.id === 'string')
    .map(m => ({ id: m.id, description: m.display_name }));
}

function joinUrl(base: string, path: string): string {
  const b = base.endsWith('/') ? base.slice(0, -1) : base;
  return `${b}/${path.replace(/^\//, '')}`;
}
