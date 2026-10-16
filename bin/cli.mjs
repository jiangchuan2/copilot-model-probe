#!/usr/bin/env node
/**
 * Command-line entry point.
 *
 * @module copilot-model-probe/cli
 */

import { writeFile } from 'node:fs/promises';
import { runProbe, renderText, renderMarkdown, renderJson, renderProgress } from '../src/index.mjs';

const USAGE = `copilot-model-probe — find out which Copilot models your account can really call

Usage
  copilot-model-probe [options]

Options
  --models <a,b,c>     probe only these ids (default: every chat-capable catalog entry)
  --only-enabled       restrict to catalog entries the service marks policy=enabled
  --concurrency <n>    parallel requests (default 4)
  --timeout <ms>       per-request timeout (default 30000)
  --json               print JSON instead of a table
  --md, --markdown     print Markdown instead of a table
  --out <file>         also write the report to a file (format follows --json/--md)
  --no-login           never start a device-code login; fail if no credential
  --token <token>      use this GitHub token instead of the cache
  -h, --help           show this help
  -v, --version        show the version

Credential resolution order
  1. --token
  2. COPILOT_GITHUB_TOKEN, then GITHUB_TOKEN, then GH_TOKEN
  3. a cached device-code grant (~/.config/copilot-model-probe/auth.json)

The first run without a credential prints a device code; authorize it in a
browser and the grant is cached outside this repository.
`;

/** Parse argv into an options object. */
function parseArgs(argv) {
  const opts = { interactive: true };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => argv[++i];
    switch (arg) {
      case '--models': opts.models = next().split(',').map((s) => s.trim()).filter(Boolean); break;
      case '--only-enabled': opts.onlyEnabled = true; break;
      case '--concurrency': opts.concurrency = Number(next()); break;
      case '--timeout': opts.timeoutMs = Number(next()); break;
      case '--json': opts.format = 'json'; break;
      case '--md': case '--markdown': opts.format = 'md'; break;
      case '--out': opts.out = next(); break;
      case '--no-login': opts.interactive = false; break;
      case '--token': opts.token = next(); break;
      case '-h': case '--help': opts.help = true; break;
      case '-v': case '--version': opts.version = true; break;
      default:
        if (arg.startsWith('-')) { console.error(`unknown option: ${arg}`); process.exit(2); }
    }
  }
  return opts;
}

const opts = parseArgs(process.argv.slice(2));

if (opts.help) { console.log(USAGE); process.exit(0); }
if (opts.version) {
  const { readFile } = await import('node:fs/promises');
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  console.log(pkg.version);
  process.exit(0);
}

const isJson = opts.format === 'json';
const isMd = opts.format === 'md';
const showProgress = !isJson && !isMd;

try {
  const outcome = await runProbe({
    token: opts.token,
    models: opts.models,
    onlyEnabled: opts.onlyEnabled,
    concurrency: opts.concurrency,
    timeoutMs: opts.timeoutMs,
    interactive: opts.interactive,
    onPrompt: ({ userCode, verificationUri }) => {
      console.log('');
      console.log('  Authorize this run at: ' + verificationUri);
      console.log('  Enter this code:       ' + userCode);
      console.log('');
      console.log('  Waiting for authorization...');
    },
    onResult: showProgress ? (r) => console.log(renderProgress(r)) : undefined,
  });

  const meta = { account: outcome.account, apiEndpoint: outcome.apiEndpoint };
  const body = isJson ? renderJson(outcome.results, meta)
    : isMd ? renderMarkdown(outcome.results, meta)
    : renderText(outcome.results, meta);

  if (!isJson && !isMd) console.log('');
  console.log(body);

  if (opts.out) {
    await writeFile(opts.out, body + '\n');
    console.error(`report written to ${opts.out}`);
  }

  const anyUsable = outcome.usable.length > 0;
  process.exit(anyUsable ? 0 : 1);
} catch (error) {
  console.error('probe failed: ' + (error?.message ?? error));
  process.exit(3);
}
