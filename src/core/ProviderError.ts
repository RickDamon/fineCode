/**
 * ProviderError — unified, human-readable wrapper over raw SDK / HTTP errors.
 *
 * Goal: instead of exposing "Error: 400 Model Not Exist" to end users, translate
 * common failures into actionable guidance ("Run `fine init` and pick a valid
 * model" / "Check your API key"), while preserving the original error for
 * debugging.
 */

export type ProviderErrorKind =
  | 'auth' // 401 / invalid api key
  | 'forbidden' // 403 / key disabled, org issue
  | 'model' // 400 model_not_found, 404 on model
  | 'rate_limit' // 429
  | 'quota' // 402 / insufficient_quota
  | 'bad_request' // generic 400
  | 'network' // connection refused, DNS, timeout
  | 'server' // 5xx
  | 'aborted' // user abort
  | 'unknown';

export interface ProviderErrorContext {
  /** Provider name, e.g. "openai", "anthropic", "deepseek" (derived from preset). */
  providerLabel?: string;
  /** Model id that was attempted. */
  model?: string;
  /** Preset if any, used to refine hints. */
  preset?: string;
  /** Base URL in play (helps diagnose "you set base URL to X by mistake"). */
  baseUrl?: string;
}

export class ProviderError extends Error {
  readonly kind: ProviderErrorKind;
  readonly status?: number;
  readonly code?: string;
  readonly hint: string;
  readonly raw?: unknown;
  readonly context: ProviderErrorContext;

  constructor(
    kind: ProviderErrorKind,
    message: string,
    opts: {
      status?: number;
      code?: string;
      hint?: string;
      raw?: unknown;
      context?: ProviderErrorContext;
    } = {},
  ) {
    super(message);
    this.name = 'ProviderError';
    this.kind = kind;
    this.status = opts.status;
    this.code = opts.code;
    this.hint = opts.hint ?? defaultHint(kind, opts.context);
    this.raw = opts.raw;
    this.context = opts.context ?? {};
  }

  /** Pretty multi-line format suitable for terminal display. */
  toDisplay(): string {
    const header = this.status
      ? `[${this.status}] ${this.message}`
      : this.message;
    return `${header}\n${this.hint}`.trim();
  }
}

/** Pattern match to classify a raw error message / status. */
function classify(status: number | undefined, msg: string): ProviderErrorKind {
  const m = msg.toLowerCase();
  // ── Auth / key issues ──
  // English: covers OpenAI / Anthropic / DeepSeek's English errors.
  // Chinese: covers 智谱 / MiniMax / 文心一言 which frequently localize.
  if (
    status === 401 ||
    /invalid.*api.?key|unauthorized|authentication|auth.?invalid/.test(m) ||
    /api.?key.*(invalid|错误|失效|无效)/.test(m) ||
    /无效.*(api.?key|密钥)|鉴权失败|身份.*未.*验证/.test(m)
  ) return 'auth';

  if (status === 403 || /forbidden|permission.denied|disabled/.test(m)) return 'forbidden';

  // ── Model not found ──
  // Adds Ollama's "model 'X' not found, try pulling it first" signature as a
  // distinct hint path, and the Chinese "模型不存在 / 无此模型" phrasing.
  if (
    status === 404 ||
    /model.?not.?(exist|found)|no such model|unknown model|does not exist|not a valid model/.test(m) ||
    /model.*not.*found.*pull/.test(m) ||
    /模型.*(不存在|未找到|无效)/.test(m)
  ) return 'model';
  if (status === 400 && /model/.test(m)) return 'model';

  // ── Quota / billing ──
  // DeepSeek sends {code:"balance_not_enough"}; 智谱 GLM sends "余额不足";
  // Moonshot sends English "insufficient_quota" on some tiers.
  if (
    status === 402 ||
    /insufficient.quota|insufficient.balance|balance_not_enough|billing|payment/.test(m) ||
    /余额不足|配额.*用尽|欠费|账户.*冻结/.test(m)
  ) return 'quota';

  // ── Rate limit ──
  if (
    status === 429 ||
    /rate.?limit|too many requests/.test(m) ||
    /请求.*过于.*频繁|频率.*超限/.test(m)
  ) return 'rate_limit';

  if (status && status >= 500) return 'server';
  if (status === 400) return 'bad_request';
  if (/abort|aborted/.test(m)) return 'aborted';
  if (/econnrefused|enotfound|etimedout|fetch failed|network|socket|timeout/.test(m))
    return 'network';
  return 'unknown';
}

function defaultHint(kind: ProviderErrorKind, ctx?: ProviderErrorContext): string {
  const model = ctx?.model ?? '<your model>';
  const preset = ctx?.preset;
  const baseUrl = ctx?.baseUrl;
  const presetTip = preset ? ` (preset: ${preset})` : '';

  switch (kind) {
    case 'auth':
      return [
        `Hint: your API key looks invalid or was rejected${presetTip}.`,
        `  • Re-enter it with \`fine init\``,
        `  • Or pass \`--api-key <key>\``,
        `  • Or set the env var (e.g. DEEPSEEK_API_KEY / OPENAI_API_KEY / ANTHROPIC_API_KEY)`,
      ].join('\n');
    case 'forbidden':
      return [
        `Hint: the API accepted the key but refused this request${presetTip}.`,
        `  • Your key may be disabled or lacks access to model "${model}"`,
        `  • Check your account/billing page on the provider's console`,
      ].join('\n');
    case 'model':
      // Ollama is the one provider that tells you *exactly* how to fix a
      // missing-model error, so surface its command verbatim.
      if (preset === 'ollama' || /ollama/i.test(baseUrl ?? '')) {
        return [
          `Hint: Ollama doesn't have model "${model}" pulled locally.`,
          `  • Run: ollama pull ${model}`,
          `  • Then retry your request.`,
          `  • List installed models: ollama list`,
        ].join('\n');
      }
      return [
        `Hint: model "${model}" is not recognized by the server${presetTip}.`,
        `  • Run \`fine doctor\` to list valid models`,
        `  • Or run \`fine init\` and pick from the suggested list`,
      ].join('\n');
    case 'rate_limit':
      return [
        `Hint: you are being rate-limited${presetTip}.`,
        `  • Wait a bit and retry`,
        `  • Or switch to a higher tier / different preset`,
      ].join('\n');
    case 'quota': {
      // Per-provider top-up URLs so the user lands on the right page quickly.
      // Kept as a small lookup — adding a provider is one line.
      const topupUrls: Record<string, string> = {
        deepseek: 'https://platform.deepseek.com/top_up',
        moonshot: 'https://platform.moonshot.cn',
        zhipu: 'https://open.bigmodel.cn/usercenter/pay',
        minimax: 'https://platform.minimax.chat/user-center',
        openai: 'https://platform.openai.com/settings/organization/billing',
        anthropic: 'https://console.anthropic.com/settings/billing',
      };
      const url = preset && topupUrls[preset];
      return [
        `Hint: your account has insufficient quota or a billing issue${presetTip}.`,
        url
          ? `  • Top up / enable billing: ${url}`
          : `  • Top up / enable billing on the provider's console`,
      ].join('\n');
    }
    case 'bad_request':
      return `Hint: the provider rejected the request. Run \`fine doctor\` for a deeper check.`;
    case 'network':
      return [
        `Hint: could not reach the API${baseUrl ? ` at ${baseUrl}` : ''}.`,
        `  • Check your internet / VPN / proxy`,
        `  • Verify \`--base-url\` if you set one`,
        `  • Run \`fine doctor\` to test connectivity`,
      ].join('\n');
    case 'server':
      return `Hint: the provider is having trouble (5xx). Try again later.`;
    case 'aborted':
      return ''; // user-initiated, no extra noise
    case 'unknown':
    default:
      return `Hint: run \`fine doctor\` to diagnose.`;
  }
}

/**
 * Extract a useful message from heterogeneous error shapes:
 *   - OpenAI SDK: err.status + err.message + err.error.code / err.error.message
 *   - Native Error: err.message
 *   - fetch Response already converted to text
 */
interface OpenAILikeError extends Error {
  status?: number;
  code?: string;
  error?: { message?: string; code?: string; type?: string };
}

export function wrapOpenAIError(err: unknown, ctx: ProviderErrorContext): ProviderError {
  if (err instanceof ProviderError) return err;
  const e = err as OpenAILikeError;
  const status = e?.status;
  const code = e?.code ?? e?.error?.code;
  const message = e?.error?.message || e?.message || String(err);
  const kind = classify(status, message);
  return new ProviderError(kind, message, { status, code, raw: err, context: ctx });
}

/** Wrap a failed HTTP response (used by the Anthropic provider). */
export async function wrapHttpError(
  resp: Response,
  ctx: ProviderErrorContext,
): Promise<ProviderError> {
  const status = resp.status;
  let bodyText = '';
  let code: string | undefined;
  try {
    bodyText = await resp.text();
  } catch {
    /* ignore */
  }
  // Try to pull code/message out of JSON body.
  let message = bodyText || resp.statusText;
  try {
    const parsed = JSON.parse(bodyText);
    message = parsed?.error?.message ?? parsed?.message ?? message;
    code = parsed?.error?.type ?? parsed?.error?.code ?? parsed?.code;
  } catch {
    /* non-JSON body, keep as-is */
  }
  const kind = classify(status, message);
  return new ProviderError(kind, message, { status, code, raw: bodyText, context: ctx });
}

/** Wrap generic thrown errors (network, timeout, etc.) */
export function wrapGenericError(err: unknown, ctx: ProviderErrorContext): ProviderError {
  if (err instanceof ProviderError) return err;
  const message = (err as Error)?.message ?? String(err);
  if ((err as Error)?.name === 'AbortError') {
    return new ProviderError('aborted', 'Request aborted', { raw: err, context: ctx });
  }
  const kind = classify(undefined, message);
  return new ProviderError(kind, message, { raw: err, context: ctx });
}
