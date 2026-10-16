# copilot-model-probe

Find out which GitHub Copilot models your account can **actually** call — by sending real requests instead of trusting the catalog.

## The problem

The Copilot `/models` endpoint advertises entries with `policy: "enabled"` that the same account is then refused with:

```
HTTP 400 {"error":{"message":"The requested model is not supported.","code":"model_not_supported"}}
```

So the catalog is a menu, not a contract. Whether a model works depends on your plan (free, educational quota, individual, business, enterprise) and GitHub changes the lineup without notice. The only reliable answer comes from **sending one minimal completion request per model and reading the status code**.

That is what this tool does.

## Install

```bash
git clone https://github.com/YOUR_USERNAME/copilot-model-probe.git
cd copilot-model-probe
node bin/cli.mjs --help
```

No dependencies. Node 18+ (uses built-in `fetch`). Optionally `npm link` to get the `copilot-model-probe` command on your PATH.

## Usage

```bash
# Probe every chat-capable model the catalog lists (first run triggers device-code login)
node bin/cli.mjs

# Only the entries marked policy=enabled, 3 at a time
node bin/cli.mjs --only-enabled --concurrency 3

# Check specific models
node bin/cli.mjs --models gpt-4.1,claude-sonnet-5,gpt-5.4

# Machine-readable output for CI or a wrapper script
node bin/cli.mjs --json --out probe-result.json

# Markdown, handy for pasting into an issue
node bin/cli.mjs --md
```

Exit codes: `0` at least one model usable, `1` none usable, `2` bad arguments, `3` probe failed.

### Example output

```
  ✗ gpt-5.4-mini                     400   809ms
  ✗ gpt-5.6-luna                     400   817ms
  ✓ gpt-4.1                          200   2997ms

GitHub Copilot model availability
========================================
account     : octocat
plan (sku)  : free_educational_quota
endpoint    : https://api.individual.githubcopilot.com
probed      : 9 model(s)

usable (2)
  gpt-4.1-2025-04-14               200   3767ms
  gpt-4.1                          200   2997ms

blocked (7)
  gpt-5.4-mini                     400   809ms  — model_not_supported
  ...

Models you can use right now:
  - gpt-4.1-2025-04-14
  - gpt-4.1
```

## Options

| flag | meaning |
| --- | --- |
| `--models a,b,c` | probe only these ids |
| `--only-enabled` | restrict to catalog entries marked `policy: enabled` |
| `--concurrency <n>` | parallel requests (default 4) |
| `--timeout <ms>` | per-request timeout (default 30000) |
| `--json` / `--md` | output format |
| `--out <file>` | also write the report to a file |
| `--no-login` | never start a login; fail if no credential |
| `--token <token>` | use this GitHub token instead of the cache |

## Credentials

Resolution order:

1. `--token`
2. `COPILOT_GITHUB_TOKEN`, then `GITHUB_TOKEN`, then `GH_TOKEN`
3. a cached device-code grant

Without any of those, the first run prints a device code and a verification URL. Authorize it in a browser and the resulting grant is cached at `~/.config/copilot-model-probe/auth.json` (`%APPDATA%\copilot-model-probe\auth.json` on Windows), mode `0600`.

Note that a bare GitHub personal access token (PAT) generally will **not** work: the Copilot API wants a token obtained through the OAuth exchange, which is what the device-code flow produces.

### Verdicts

| verdict | meaning |
| --- | --- |
| `usable` | a real completion came back |
| `blocked` | `400`/`404` — your plan may not call this model (`model_not_supported`) |
| `throttled` | `429` — out of quota right now, retry later |
| `unauthorized` | `401`/`403` — credential rejected |
| `error` | transport failure or an unclassified status |

## Programmatic use

```js
import { runProbe, renderMarkdown } from 'copilot-model-probe';

const outcome = await runProbe({ onlyEnabled: true, concurrency: 4 });
console.log(outcome.account.sku);   // e.g. 'free_educational_quota'
console.log(outcome.usable);        // ['gpt-4.1', ...]
console.log(renderMarkdown(outcome.results, outcome));
```

Lower-level pieces are exported too: `resolveToken`, `fetchCatalog`, `probeModel`, `probeMany`, `describeAccount`, `renderJson`, and the `VERDICT` constants.

## Tests

```bash
node test/run-all.mjs
```

Ten cases cover status classification, catalog filtering, transport failures, concurrency bounds, and all three renderers. `fetch` is stubbed, so the suite makes no network calls.

## Notes and limits

- **This does not unlock anything.** The refusal comes from the service, keyed to your account's plan. No client-side change can bypass it — the tool tells you what you have, not what you wish you had.
- Probing spends a sliver of quota: each request asks for 5 output tokens. A full sweep of ~30 models is negligible against a monthly allowance, but it is not literally free.
- `policy: enabled` is a hint, not a promise. That is the entire reason this tool exists.
- GitHub can change the model ids, the header set, or the endpoint at any time; if a run suddenly reports everything `error`, check those first.

## License

MIT
