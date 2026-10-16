/**
 * Single-process test runner.
 *
 * `node --test` spawns a child per file, which some sandboxes forbid. This
 * runner executes every assertion inline so the suite works anywhere Node does.
 *
 * @module copilot-model-probe/test
 */

import assert from 'node:assert/strict';

import { classify, chatCandidates, probeModel, probeMany, VERDICT } from '../src/probe.mjs';
import { renderText, renderMarkdown, renderJson, groupByVerdict } from '../src/report.mjs';

let passed = 0;
let failed = 0;
const failures = [];

/** Run one named case, recording instead of aborting on failure. */
async function it(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ok   ${name}`);
  } catch (error) {
    failed++;
    failures.push({ name, error });
    console.log(`  FAIL ${name}`);
    console.log(`       ${error?.message?.split('\n')[0] ?? error}`);
  }
}

/** Swap global fetch for the duration of one case. */
async function withFetch(impl, fn) {
  const original = globalThis.fetch;
  globalThis.fetch = impl;
  try { return await fn(); } finally { globalThis.fetch = original; }
}

console.log('probe');
await it('classify maps status codes to verdicts', () => {
  assert.equal(classify(200), VERDICT.OK);
  assert.equal(classify(400), VERDICT.UNSUPPORTED);
  assert.equal(classify(404), VERDICT.UNSUPPORTED);
  assert.equal(classify(401), VERDICT.UNAUTHORIZED);
  assert.equal(classify(403), VERDICT.UNAUTHORIZED);
  assert.equal(classify(429), VERDICT.THROTTLED);
  assert.equal(classify(500), VERDICT.ERROR);
});

await it('chatCandidates drops infrastructure models', () => {
  const catalog = [
    { id: 'gpt-4.1' },
    { id: 'text-embedding-3-small' },
    { id: 'trajectory-compaction' },
    { id: 'copilot-search-a' },
    { id: 'exec-agent-a' },
    { id: 'gpt-5.4-mini-free-auto' },
    { id: 'kimi-k3-base' },
    { id: 'claude-sonnet-5' },
  ];
  assert.deepEqual(chatCandidates(catalog).map((m) => m.id), ['gpt-4.1', 'claude-sonnet-5']);
});

await it('probeModel reports an unsupported model without throwing', () => withFetch(
  async () => new Response(JSON.stringify({ error: { code: 'model_not_supported' } }), { status: 400 }),
  async () => {
    const r = await probeModel('nope', { access: 'x', apiEndpoint: 'https://example.invalid' });
    assert.equal(r.verdict, VERDICT.UNSUPPORTED);
    assert.equal(r.status, 400);
    assert.equal(r.detail, 'model_not_supported');
  },
));

await it('probeModel reports success on 2xx', () => withFetch(
  async () => new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), { status: 200 }),
  async () => {
    const r = await probeModel('good', { access: 'x', apiEndpoint: 'https://example.invalid' });
    assert.equal(r.verdict, VERDICT.OK);
  },
));

await it('probeModel survives a transport failure', () => withFetch(
  async () => { throw new Error('socket hang up'); },
  async () => {
    const r = await probeModel('boom', { access: 'x', apiEndpoint: 'https://example.invalid' });
    assert.equal(r.verdict, VERDICT.ERROR);
    assert.equal(r.status, 'ERR');
  },
));

await it('probeMany keeps input order and honors concurrency', () => {
  let inFlight = 0;
  let peak = 0;
  return withFetch(
    async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return new Response('{}', { status: 200 });
    },
    async () => {
      const models = ['a', 'b', 'c', 'd', 'e'];
      const results = await probeMany(models, { access: 'x', apiEndpoint: 'https://example.invalid', concurrency: 2 });
      assert.deepEqual(results.map((r) => r.model), models);
      assert.ok(peak <= 2, `peak concurrency was ${peak}`);
    },
  );
});

const sample = [
  { model: 'gpt-4.1', verdict: 'ok', status: 200, latencyMs: 900 },
  { model: 'gpt-5.4', verdict: 'unsupported', status: 400, detail: 'model_not_supported', latencyMs: 300 },
];

console.log('report');
await it('groupByVerdict buckets results', () => {
  const g = groupByVerdict(sample);
  assert.equal(g.get('ok').length, 1);
  assert.equal(g.get('unsupported').length, 1);
  assert.equal(g.get('throttled').length, 0);
});

await it('renderText lists usable models', () => {
  const out = renderText(sample, { account: { login: 'someone', sku: 'free_limited_copilot' } });
  assert.match(out, /usable \(1\)/);
  assert.match(out, /- gpt-4\.1/);
});

await it('renderMarkdown produces a table', () => {
  const out = renderMarkdown(sample, { account: { login: 'someone' } });
  assert.match(out, /\| model \| verdict \|/);
  assert.match(out, /`gpt-4\.1`/);
});

await it('renderJson round-trips', () => {
  const parsed = JSON.parse(renderJson(sample, { account: { login: 'someone' } }));
  assert.deepEqual(parsed.usable, ['gpt-4.1']);
  assert.equal(parsed.results.length, 2);
});

console.log('');
console.log(`${passed} passed, ${failed} failed`);
if (failed > 0) {
  for (const f of failures) console.log(`\n--- ${f.name} ---\n${f.error?.stack ?? f.error}`);
  process.exit(1);
}
