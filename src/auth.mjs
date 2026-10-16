/**
 * Authentication for the Copilot API.
 *
 * Three ways in, in order of preference:
 *   1. An explicit GitHub token passed by the caller.
 *   2. The GITHUB_TOKEN / GH_TOKEN / COPILOT_GITHUB_TOKEN environment variables.
 *   3. An interactive device-code login, cached under the OS config dir.
 *
 * Nothing here ever writes a token into the repository: the device-code cache
 * lives outside the working tree, and .gitignore blocks the obvious accidents.
 *
 * @module copilot-model-probe/auth
 */

import { mkdir, readFile, writeFile, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** GitHub's public OAuth client id, as used by the Copilot editor plugins. */
const CLIENT_ID = 'Iv1.b507a08c87ecfe98';

/** Editor identity the Copilot API expects on every request. */
export const COPILOT_HEADERS = {
  'User-Agent': 'GitHubCopilotChat/0.35.0',
  'Editor-Version': 'vscode/1.107.0',
  'Editor-Plugin-Version': 'copilot-chat/0.35.0',
  'Copilot-Integration-Id': 'vscode-chat',
};

/** Wire version the models endpoint currently requires. */
export const COPILOT_API_VERSION = '2026-06-01';

/** Cache location, deliberately outside any repository. */
function cacheDir() {
  const base = process.env.XDG_CONFIG_HOME
    || (process.platform === 'win32' ? process.env.APPDATA : null)
    || join(homedir(), '.config');
  return join(base, 'copilot-model-probe');
}

const cachePath = () => join(cacheDir(), 'auth.json');

/**
 * Read the cached device-code grant, if one exists.
 * @returns {Promise<{refresh: string, access: string, expires: number} | null>}
 */
export async function readCachedGrant() {
  try {
    const raw = JSON.parse(await readFile(cachePath(), 'utf8'));
    if (typeof raw?.refresh === 'string' && typeof raw?.access === 'string') return raw;
    return null;
  } catch {
    return null;
  }
}

/**
 * Persist a grant outside the working tree, readable only by this user.
 * @param {{refresh: string, access: string, expires: number}} grant
 */
export async function writeCachedGrant(grant) {
  await mkdir(cacheDir(), { recursive: true, mode: 0o700 });
  await writeFile(cachePath(), JSON.stringify(grant, null, 2), { mode: 0o600 });
}

/** Remove the cached grant. */
export async function clearCachedGrant() {
  await unlink(cachePath()).catch(() => {});
}

/** The GitHub token to exchange, from the environment. */
export function tokenFromEnv() {
  return process.env.COPILOT_GITHUB_TOKEN
    || process.env.GITHUB_TOKEN
    || process.env.GH_TOKEN
    || null;
}

/**
 * Ask GitHub for a device code, then poll until the human authorizes.
 * @param {{onPrompt?: (p: {userCode: string, verificationUri: string, expiresIn: number}) => void, signal?: AbortSignal}} [options]
 * @returns {Promise<string>} the GitHub access token
 */
export async function deviceCodeLogin({ onPrompt, signal } = {}) {
  const start = await fetch('https://github.com/login/device/code', {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded', ...COPILOT_HEADERS },
    body: new URLSearchParams({ client_id: CLIENT_ID, scope: 'read:user' }),
    signal,
  });
  if (!start.ok) throw new Error(`device code request failed: ${start.status} ${await start.text()}`);
  const code = await start.json();
  const interval = (code.interval ?? 5) * 1000;
  const deadline = Date.now() + (code.expires_in ?? 900) * 1000;

  onPrompt?.({
    userCode: code.user_code,
    verificationUri: code.verification_uri,
    expiresIn: code.expires_in ?? 900,
  });

  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, interval));
    const res = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded', ...COPILOT_HEADERS },
      body: new URLSearchParams({
        client_id: CLIENT_ID,
        device_code: code.device_code,
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      }),
      signal,
    });
    const data = await res.json();
    if (typeof data.access_token === 'string') return data.access_token;
    if (data.error === 'authorization_pending') continue;
    if (data.error === 'slow_down') { await new Promise((r) => setTimeout(r, interval)); continue; }
    throw new Error(`device flow failed: ${data.error ?? 'unknown'}${data.error_description ? ': ' + data.error_description : ''}`);
  }
  throw new Error('device flow expired before authorization completed');
}

/**
 * Exchange a GitHub token for a short-lived Copilot session token.
 * @param {string} githubToken
 * @returns {Promise<{access: string, expires: number, apiEndpoint: string, refresh: string}>}
 */
export async function exchangeForCopilotToken(githubToken) {
  const res = await fetch('https://api.github.com/copilot_internal/v2/token', {
    headers: { Accept: 'application/json', Authorization: `Bearer ${githubToken}`, ...COPILOT_HEADERS },
  });
  if (!res.ok) {
    throw new Error(
      `Copilot token exchange failed: ${res.status} ${(await res.text()).slice(0, 200)} — `
      + 'this account may not have Copilot access',
    );
  }
  const data = await res.json();
  const proxy = String(data.token).match(/proxy-ep=([^;]+)/)?.[1];
  return {
    access: data.token,
    expires: data.expires_at * 1000 - 5 * 60 * 1000,
    apiEndpoint: data.endpoints?.api ?? (proxy ? `https://${proxy.replace(/^proxy\./, 'api.')}` : 'https://api.individual.githubcopilot.com'),
    refresh: githubToken,
  };
}

/**
 * Resolve a usable Copilot token, refreshing or logging in as needed.
 * @param {{token?: string, interactive?: boolean, onPrompt?: Function, signal?: AbortSignal}} [options]
 * @returns {Promise<{access: string, apiEndpoint: string, source: string, planHint?: string}>}
 */
export async function resolveToken({ token, interactive = true, onPrompt, signal } = {}) {
  // Explicit token or environment: exchange directly, do not cache.
  const explicit = token || tokenFromEnv();
  if (explicit) {
    const g = await exchangeForCopilotToken(explicit);
    return { access: g.access, apiEndpoint: g.apiEndpoint, source: token ? 'argument' : 'environment' };
  }

  // Cached device-code grant: reuse while fresh, otherwise refresh.
  const cached = await readCachedGrant();
  if (cached) {
    if (Date.now() < cached.expires - 60_000) {
      const proxy = cached.access.match(/proxy-ep=([^;]+)/)?.[1];
      return {
        access: cached.access,
        apiEndpoint: proxy ? `https://${proxy.replace(/^proxy\./, 'api.')}` : 'https://api.individual.githubcopilot.com',
        source: 'cache',
      };
    }
    try {
      const g = await exchangeForCopilotToken(cached.refresh);
      await writeCachedGrant(g);
      return { access: g.access, apiEndpoint: g.apiEndpoint, source: 'cache-refreshed' };
    } catch {
      await clearCachedGrant();
    }
  }

  if (!interactive) {
    throw new Error(
      'no Copilot credential available: pass a token, set COPILOT_GITHUB_TOKEN / GITHUB_TOKEN, '
      + 'or run without --no-login to sign in',
    );
  }

  const githubToken = await deviceCodeLogin({ onPrompt, signal });
  const g = await exchangeForCopilotToken(githubToken);
  await writeCachedGrant(g);
  return { access: g.access, apiEndpoint: g.apiEndpoint, source: 'device-login' };
}

/**
 * Ask GitHub what it thinks this account is entitled to.
 * @param {string} githubToken
 * @returns {Promise<{login?: string, plan?: string, sku?: string, chatEnabled?: boolean}>}
 */
export async function describeAccount(githubToken) {
  try {
    const res = await fetch('https://api.github.com/copilot_internal/user', {
      headers: { Accept: 'application/json', Authorization: `Bearer ${githubToken}`, ...COPILOT_HEADERS },
    });
    if (!res.ok) return {};
    const d = await res.json();
    return { login: d.login, plan: d.copilot_plan, sku: d.access_type_sku, chatEnabled: d.chat_enabled };
  } catch {
    return {};
  }
}
