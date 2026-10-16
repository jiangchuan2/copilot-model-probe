/**
 * Probe which models an account can actually call.
 *
 * The Copilot /models catalog is not a contract: it lists entries with
 * `policy: enabled` that the same account is then refused with
 * `model_not_supported`. The only reliable answer comes from sending a real,
 * minimal completion request and reading the status code.
 *
 * @module copilot-model-probe/probe
 */

import { COPILOT_HEADERS, COPILOT_API_VERSION } from './auth.mjs';

/** Decision values a probe can produce for one model. */
export const VERDICT = {
  /** A real completion came back. */
  OK: 'ok',
  /** The account may not call this model. */
  UNSUPPORTED: 'unsupported',
  /** Rate limited or out of quota; retrying later may succeed. */
  THROTTLED: 'throttled',
  /** The credential was rejected. */
  UNAUTHORIZED: 'unauthorized',
  /** Transport error, timeout, or an unclassified status. */
  ERROR: 'error',
};

/** Classify one HTTP response into a verdict. */
export function classify(status) {
  if (status >= 200 && status < 300) return VERDICT.OK;
  if (status === 400 || status === 404) return VERDICT.UNSUPPORTED;
  if (status === 401 || status === 403) return VERDICT.UNAUTHORIZED;
  if (status === 429) return VERDICT.THROTTLED;
  return VERDICT.ERROR;
}

/**
 * Read the catalog without trusting its policy field as a verdict.
 * @param {{access: string, apiEndpoint: string, signal?: AbortSignal}} ctx
 * @returns {Promise<Array<{id: string, pickerEnabled: boolean, policy?: string, supportsTools?: boolean}>>}
 */
export async function fetchCatalog({ access, apiEndpoint, signal }) {
  const res = await fetch(`${apiEndpoint}/models`, {
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${access}`,
      ...COPILOT_HEADERS,
      'X-GitHub-Api-Version': COPILOT_API_VERSION,
    },
    signal,
  });
  if (!res.ok) throw new Error(`catalog request failed: ${res.status} ${(await res.text()).slice(0, 200)}`);
  const body = await res.json();
  if (!Array.isArray(body?.data)) throw new Error('catalog response had no data array');
  return body.data.map((m) => ({
    id: m.id,
    pickerEnabled: m.model_picker_enabled === true,
    policy: m.policy?.state,
    supportsTools: m.capabilities?.supports?.tool_calls,
  }));
}

/** Model ids that are infrastructure rather than chat choices. */
const NON_CHAT = /(embedding|trajectory-compaction|copilot-search|exec-agent|-free-auto$|-base$|-copilot$)/;

/**
 * Heuristic filter for entries worth probing.
 * @param {Array} catalog
 * @returns {Array} chat-capable candidates
 */
export function chatCandidates(catalog) {
  return catalog.filter((m) => !NON_CHAT.test(m.id));
}

/**
 * Send one minimal completion and classify what comes back.
 * @param {string} model
 * @param {{access: string, apiEndpoint: string, timeoutMs?: number}} ctx
 * @returns {Promise<{model: string, verdict: string, status: number|string, detail?: string, latencyMs: number}>}
 */
export async function probeModel(model, { access, apiEndpoint, timeoutMs = 30_000 }) {
  const started = Date.now();
  try {
    const res = await fetch(`${apiEndpoint}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${access}`,
        ...COPILOT_HEADERS,
        'X-GitHub-Api-Version': COPILOT_API_VERSION,
      },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: 'ok' }],
        max_tokens: 5,
        stream: false,
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const latencyMs = Date.now() - started;
    if (res.ok) {
      return { model, verdict: VERDICT.OK, status: res.status, latencyMs };
    }
    let detail = '';
    try {
      const body = await res.json();
      detail = body?.error?.code ?? body?.message ?? '';
    } catch {
      detail = (await res.text().catch(() => '')).slice(0, 120);
    }
    return {
      model,
      verdict: classify(res.status),
      status: res.status,
      detail: String(detail).slice(0, 160),
      latencyMs,
    };
  } catch (error) {
    const msg = String(error?.message ?? error);
    return {
      model,
      verdict: /abort|timeout/i.test(msg) ? VERDICT.ERROR : VERDICT.ERROR,
      status: 'ERR',
      detail: msg.slice(0, 160),
      latencyMs: Date.now() - started,
    };
  }
}

/**
 * Probe many models, optionally with bounded concurrency.
 * @param {string[]} models
 * @param {{access: string, apiEndpoint: string, concurrency?: number, timeoutMs?: number, onResult?: Function}} ctx
 * @returns {Promise<Array>}
 */
export async function probeMany(models, { access, apiEndpoint, concurrency = 4, timeoutMs, onResult }) {
  const results = [];
  let cursor = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(concurrency, models.length)) }, async () => {
    while (cursor < models.length) {
      const model = models[cursor++];
      const r = await probeModel(model, { access, apiEndpoint, timeoutMs });
      results.push(r);
      onResult?.(r);
    }
  });
  await Promise.all(workers);
  return results.sort((a, b) => models.indexOf(a.model) - models.indexOf(b.model));
}
