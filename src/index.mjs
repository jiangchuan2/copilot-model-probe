/**
 * Probe which GitHub Copilot models an account can actually call.
 *
 * The Copilot catalog advertises models the account is then refused. This
 * package answers the only question that matters — what works right now — by
 * sending a real minimal completion per model and reading the status code.
 *
 * @module copilot-model-probe
 */

export {
  COPILOT_HEADERS,
  COPILOT_API_VERSION,
  deviceCodeLogin,
  exchangeForCopilotToken,
  resolveToken,
  describeAccount,
  readCachedGrant,
  writeCachedGrant,
  clearCachedGrant,
  tokenFromEnv,
} from './auth.mjs';

export {
  VERDICT,
  classify,
  fetchCatalog,
  chatCandidates,
  probeModel,
  probeMany,
} from './probe.mjs';

export {
  groupByVerdict,
  renderText,
  renderMarkdown,
  renderJson,
  renderProgress,
} from './report.mjs';

import { resolveToken, describeAccount, tokenFromEnv, readCachedGrant } from './auth.mjs';
import { fetchCatalog, chatCandidates, probeMany, VERDICT } from './probe.mjs';

/**
 * Run a complete probe: resolve a credential, read the catalog, test every
 * chat-capable model, and return both the raw results and the usable subset.
 *
 * @param {{
 *   token?: string,
 *   models?: string[],
 *   onlyEnabled?: boolean,
 *   concurrency?: number,
 *   timeoutMs?: number,
 *   interactive?: boolean,
 *   onPrompt?: Function,
 *   onResult?: Function,
 *   signal?: AbortSignal,
 * }} [options]
 * @returns {Promise<{account: object, apiEndpoint: string, results: Array, usable: string[], catalog: Array}>}
 */
export async function runProbe(options = {}) {
  const {
    token, models, onlyEnabled = false, concurrency = 4, timeoutMs = 30_000,
    interactive = true, onPrompt, onResult, signal,
  } = options;

  const auth = await resolveToken({ token, interactive, onPrompt, signal });

  const accountToken = token || tokenFromEnv() || (await readCachedGrant())?.refresh;
  const account = accountToken ? await describeAccount(accountToken) : {};

  const catalog = await fetchCatalog({ access: auth.access, apiEndpoint: auth.apiEndpoint, signal });

  let targets = models?.length ? models : chatCandidates(catalog).map((m) => m.id);
  if (onlyEnabled) {
    const enabled = new Set(catalog.filter((m) => m.policy === 'enabled').map((m) => m.id));
    targets = targets.filter((id) => enabled.has(id));
  }

  const results = await probeMany(targets, {
    access: auth.access,
    apiEndpoint: auth.apiEndpoint,
    concurrency,
    timeoutMs,
    onResult,
  });

  return {
    account,
    apiEndpoint: auth.apiEndpoint,
    source: auth.source,
    results,
    usable: results.filter((r) => r.verdict === VERDICT.OK).map((r) => r.model),
    catalog,
  };
}
