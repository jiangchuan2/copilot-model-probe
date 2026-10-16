/**
 * Render probe results as a console table, Markdown, or JSON.
 *
 * @module copilot-model-probe/report
 */

import { VERDICT } from './probe.mjs';

/** Display order and label for each verdict. */
const ORDER = [VERDICT.OK, VERDICT.THROTTLED, VERDICT.UNSUPPORTED, VERDICT.UNAUTHORIZED, VERDICT.ERROR];
const LABEL = {
  [VERDICT.OK]: 'usable',
  [VERDICT.THROTTLED]: 'throttled',
  [VERDICT.UNSUPPORTED]: 'blocked',
  [VERDICT.UNAUTHORIZED]: 'unauthorized',
  [VERDICT.ERROR]: 'error',
};

/** Group results by verdict, in display order. */
export function groupByVerdict(results) {
  const groups = new Map(ORDER.map((v) => [v, []]));
  for (const r of results) (groups.get(r.verdict) ?? groups.get(VERDICT.ERROR)).push(r);
  return groups;
}

/**
 * Render a plain-text report.
 * @param {Array} results
 * @param {{account?: object, apiEndpoint?: string}} [meta]
 * @returns {string}
 */
export function renderText(results, meta = {}) {
  const lines = [];
  lines.push('GitHub Copilot model availability');
  lines.push('='.repeat(40));
  if (meta.account?.login) lines.push(`account     : ${meta.account.login}`);
  if (meta.account?.sku) lines.push(`plan (sku)  : ${meta.account.sku}`);
  if (meta.apiEndpoint) lines.push(`endpoint    : ${meta.apiEndpoint}`);
  lines.push(`probed      : ${results.length} model(s)`);
  lines.push('');

  const groups = groupByVerdict(results);
  for (const verdict of ORDER) {
    const items = groups.get(verdict);
    if (!items.length) continue;
    lines.push(`${LABEL[verdict]} (${items.length})`);
    for (const item of items) {
      const detail = item.detail ? `  — ${item.detail}` : '';
      lines.push(`  ${item.model.padEnd(32)} ${String(item.status).padEnd(5)} ${item.latencyMs}ms${detail}`);
    }
    lines.push('');
  }

  const usable = groups.get(VERDICT.OK).map((r) => r.model);
  lines.push('Models you can use right now:');
  lines.push(usable.length ? usable.map((m) => `  - ${m}`).join('\n') : '  (none)');
  return lines.join('\n');
}

/**
 * Render a Markdown report, suitable for pasting into an issue.
 * @param {Array} results
 * @param {{account?: object, apiEndpoint?: string}} [meta]
 * @returns {string}
 */
export function renderMarkdown(results, meta = {}) {
  const lines = [];
  lines.push('# GitHub Copilot model availability');
  lines.push('');
  lines.push('| field | value |');
  lines.push('| --- | --- |');
  if (meta.account?.login) lines.push(`| account | \`${meta.account.login}\` |`);
  if (meta.account?.sku) lines.push(`| plan (sku) | \`${meta.account.sku}\` |`);
  if (meta.apiEndpoint) lines.push(`| endpoint | \`${meta.apiEndpoint}\` |`);
  lines.push(`| probed | ${results.length} |`);
  lines.push('');
  lines.push('| model | verdict | status | latency | detail |');
  lines.push('| --- | --- | --- | --- | --- |');
  for (const r of results) {
    lines.push(`| \`${r.model}\` | ${LABEL[r.verdict]} | ${r.status} | ${r.latencyMs}ms | ${(r.detail ?? '').replace(/\|/g, '\\|')} |`);
  }
  lines.push('');
  const usable = results.filter((r) => r.verdict === VERDICT.OK).map((r) => r.model);
  lines.push('## Usable models');
  lines.push('');
  lines.push(usable.length ? usable.map((m) => `- \`${m}\``).join('\n') : '_none_');
  return lines.join('\n');
}

/**
 * Render machine-readable JSON.
 * @param {Array} results
 * @param {{account?: object, apiEndpoint?: string, generatedAt?: string}} [meta]
 * @returns {string}
 */
export function renderJson(results, meta = {}) {
  return JSON.stringify({
    generatedAt: meta.generatedAt ?? new Date().toISOString(),
    account: meta.account?.login ? { login: meta.account.login, sku: meta.account.sku } : undefined,
    apiEndpoint: meta.apiEndpoint,
    usable: results.filter((r) => r.verdict === VERDICT.OK).map((r) => r.model),
    results,
  }, null, 2);
}

/** ANSI color for a verdict, empty when the stream is not a TTY. */
function color(verdict, text, useColor) {
  if (!useColor) return text;
  const code = {
    [VERDICT.OK]: '\x1b[32m',
    [VERDICT.THROTTLED]: '\x1b[33m',
    [VERDICT.UNSUPPORTED]: '\x1b[31m',
    [VERDICT.UNAUTHORIZED]: '\x1b[35m',
    [VERDICT.ERROR]: '\x1b[90m',
  }[verdict];
  return `${code}${text}\x1b[0m`;
}

/** One-line progress rendering for a probe in flight. */
export function renderProgress(result, { useColor = process.stdout.isTTY } = {}) {
  const mark = result.verdict === VERDICT.OK ? '✓' : result.verdict === VERDICT.THROTTLED ? '~' : '✗';
  return `  ${color(result.verdict, mark, useColor)} ${result.model.padEnd(32)} ${String(result.status).padEnd(5)} ${result.latencyMs}ms`;
}
