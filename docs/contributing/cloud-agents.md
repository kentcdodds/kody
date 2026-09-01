# Cursor Cloud Agent notes

Kody runs on Cloudflare Workers: the origin app/MCP worker plus platform,
runtime, jobs, and status workers (Remix 3 UI + OAuth-protected MCP). See
[`local development`](./setup/local-development.md) for the local dev guide;
this document covers Cloud Agent VM gotchas only.

## Node 26

The repo requires Node **>=26** (`engines` in root `package.json`). Cloud Agent
VMs may ship Node 22 at `/exec-daemon/node`, which takes precedence over nvm
unless nvm’s Node 26 bin directory is prepended to `PATH`. Verify with
`node --version` before running scripts.

## Playwright browsers

Playwright's Chromium (used by `npm run test:e2e:run` / `validate`) is
pre-installed in `~/.cache/ms-playwright` and persists in the VM snapshot, so
normally nothing extra is needed. The **non-obvious gotcha**:
`playwright install` (and `test:e2e:install` / `test:e2e:ensure`) **hangs** on
this VM kernel — its Node-based zip extractor stalls on an `io_uring` write
partway through (around `libwidevinecdm.so`), and `UV_USE_IO_URING=0` does not
stop it. The browser zip downloads fine; only the built-in extraction hangs.

If browsers are ever missing (e.g. a Playwright version bump changes the
revision), do **not** rely on `playwright install`. Instead download and extract
manually with native `unzip`:

1. Get the revision + Chrome-for-Testing version from
   `node_modules/playwright-core/browsers.json` and the CDN URL printed by
   `npx playwright install chromium` (form:
   `https://cdn.playwright.dev/builds/cft/<cft-version>/linux64/chrome-linux64.zip`
   and `.../chrome-headless-shell-linux64.zip`).
2. `curl -fsSL -o /tmp/c.zip <chrome-linux64.zip>` then
   `unzip -q /tmp/c.zip -d ~/.cache/ms-playwright/chromium-<rev>/` and
   `touch ~/.cache/ms-playwright/chromium-<rev>/INSTALLATION_COMPLETE`.
3. Repeat for the headless shell into
   `~/.cache/ms-playwright/chromium_headless_shell-<rev>/` (Playwright launches
   headless via the separate headless-shell binary, so both are required).
4. `chmod +x` the `chrome` and `chrome-headless-shell` binaries.

## Nx remote cache

Validate and `test:push` write Nx task artifacts. Those stay local unless the
self-hosted cache is configured. To populate GitHub Actions hits, set both on
the Cloud **environment** (not a one-off `export`). Use the write token
(`NX_SELF_HOSTED_REMOTE_CACHE_ACCESS_TOKEN`). Same-repo Actions validate uses
that token too; only fork `pull_request` jobs use the read token:

```bash
export NX_SELF_HOSTED_REMOTE_CACHE_SERVER=https://nx-cache.kody.codes
export NX_SELF_HOSTED_REMOTE_CACHE_ACCESS_TOKEN="$NX_CACHE_WRITE_TOKEN"
```

Use `CI=1` on cached test commands (the repo scripts already do). Leave the
variables unset to run without remote cache. See
[`packages/nx-cache/readme.md`](../packages/nx-cache/readme.md).

## Git hooks

Cursor Cloud Agent VMs set `core.hooksPath` to a dispatcher under
`~/.cursor/agent-hooks/` so Cursor can run secret-scan and co-author hooks.
`npm run hooks:ensure` (`prepare` runs it after `husky`) composes that
dispatcher with Husky: `core.hooksPath` stays on the dispatcher,
`.cursor-original-hooks-path` points at `.husky/_`, and `pre-push` /
`pre-commit` / `commit-msg` become dispatcher symlinks when those user scripts
exist. `git push` then runs `npm run test:push` (`test:node` + `test:workers`)
and can upload those Nx remote-cache artifacts before GitHub Actions starts.
Playwright E2E is not in the push hook: that suite is heavier than the unit
gate, and a failed e2e leg skips the unit gate when the push is retried with
`--no-verify`. Bundler artifacts live under `src/node_modules/.kody-generated/`
and wrangler-env clears that collector's additional-module watches and disables
esbuild's source-graph watcher in `CLOUDFLARE_ENV=test`
(`WRANGLER_DISABLE_BUNDLE_WATCH`) so `wrangler dev` does not loop on overlay
create events. Run `npm run test:e2e:run` or `npm run validate` for the
Playwright gate locally. `wrangler-env.ts` applies
`tools/patch-wrangler-proxy-worker-errors.ts` before `wrangler dev` so a
request-scoped ProxyWorker failure does not exit the Playwright webServer. It
also defaults `X_LOCAL_EXPLORER=false` on `dev` because wrangler 4.127+ local
explorer writes under `.wrangler/tmp` on these VMs, retriggers esbuild, and
leaves ProxyWorker in a pause/reload loop after Ready. Opt in with
`X_LOCAL_EXPLORER=true`.

Cloud Agent environment `start` should run `npm run hooks:ensure` so a snapshot
boot that skips `npm ci` still composes hooks after Cursor installs the
dispatcher. The command is a no-op on machines without `~/.cursor/agent-hooks`.

## Quick commands

| Task               | Command                                                                                                                          |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| Install deps       | `npm install`                                                                                                                    |
| Start or reuse dev | `npm run dev:ensure` (prints the resolved URL)                                                                                   |
| Migrate local D1   | `npm run migrate:local`                                                                                                          |
| Seed test login    | `node tools/seed-test-data.ts --local` (see seeding note below)                                                                  |
| Full validate gate | `npm run validate` (CI runs the same checks as parallel jobs)                                                                    |
| Manual PR preview  | `npm run preview:manual-test` (see preview-manual-testing.md)                                                                    |
| App verification   | `npm run control-kody -- doctor` then `login` / `request` / `map` / `preview` / `health` (see [control-kody](./control-kody.md)) |

## Dev server

- `npm run dev:ensure` is the agent entry point. It probes origin `/health` on
  3742–3751, prints `App running at http://localhost:<port>` and exits 0 when a
  server is already up, waits for a kody/workerd leftover that accepts TCP but
  does not serve `/health` before replacing it, then starts `npm run dev` and
  waits until `/health` is actually ok before printing the resolved URL. If the
  latest wrangler line is Reloading and `/health` still misses the budget, the
  process is left running so a retry can reuse it. UI verification opens that
  real origin (for example `/onboarding`); do not substitute a `renderToString`
  dump of one component.
- `npm run dev` starts the client esbuild watcher and waits up to 30s for the
  first `public/client-entry.js` write before launching Wrangler, so that first
  bundle does not hit wrangler's assets watcher. If the wait expires, Wrangler
  still starts and may reload when the bundle lands. Then the optional
  Cloudflare API mock worker and Wrangler run origin plus generated platform,
  runtime, and jobs siblings in one Miniflare (local D1/KV/DO persistence).
  Non-TTY sessions print `App running at` only after `/health` responds.
- Default worker port is **3742** (`cli.ts`); the CLI picks a free port when
  3742 is taken and prints `App running at http://localhost:<port>`.
- Run long-lived interactive `npm run dev` in tmux so the session survives tool
  timeouts. `dev:ensure` detaches the started process so the ensure command can
  exit.
- Health check (no auth): `curl http://localhost:<port>/health` →
  `{"ok":true,"commitSha":...,"commit":...,"pullRequest":...,"deploy":...}`.
  Locally the extra fields are `null` unless a deploy var is set. Platform and
  runtime health paths (`/__platform/health`, `/__runtime/health`) 404 on the
  origin port.

## Environment file

Copy `packages/worker/.env.example` to `packages/worker/.env` if missing.
`COOKIE_SECRET` and `SECRET_STORE_KEY` are required for local dev.

## Seeding a test account

After `npm run migrate:local`, seed the local fixture logins per
[`seeding`](./setup/seeding.md): `kody@example.com` / `ilikecode` (seeded with
the `admin` role) and `jane@example.com` / `ilikecode` (regular account). These
credentials are local test fixtures only. The seed script resolves the worker
Wrangler config automatically (same default as `wrangler-env.ts`), so
`node tools/seed-test-data.ts --local` works without extra flags.

## Local limitations

- Vectorize bindings are not emulated locally; capability search uses the
  offline ranker when `WRANGLER_IS_LOCAL_DEV` is set (normal for `npm run dev`).
- `/mcp` returns **401** without OAuth; use browser login or MCP E2E tests for
  authenticated MCP checks.
