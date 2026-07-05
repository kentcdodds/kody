# Cursor Cloud Agent notes

Kody is a single Cloudflare Workers app (Remix 3 UI + OAuth-protected MCP). See
[`setup.md`](./setup.md) for the full local dev guide; this document covers
Cloud Agent VM gotchas only.

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

## Quick commands

| Task             | Command                                                         |
| ---------------- | --------------------------------------------------------------- |
| Install deps     | `npm install`                                                   |
| Start dev        | `npm run dev` (prints the resolved URL)                         |
| Migrate local D1 | `npm run migrate:local`                                         |
| Seed test login  | `node tools/seed-test-data.ts --local` (see seeding note below) |
| Full CI gate     | `npm run validate`                                              |

## Dev server

- `npm run dev` starts the client esbuild watcher, optional Cloudflare API mock
  worker, and the main worker with local D1/KV/DO persistence.
- Default worker port is **3742** (`cli.ts`); the CLI picks a free port when
  3742 is taken and prints `App running at http://localhost:<port>`.
- Run long-lived dev in tmux so the session survives tool timeouts.
- Health check (no auth): `curl http://localhost:<port>/health` →
  `{"ok":true,"commitSha":...}`.

## Environment file

Copy `packages/worker/.env.example` to `packages/worker/.env` if missing.
`COOKIE_SECRET` and `SECRET_STORE_KEY` are required for local dev.

## Seeding a test account

After `npm run migrate:local`, seed the local fixture logins per
[`setup.md`](./setup.md): `kody@example.com` / `ilikecode` (seeded with the
`admin` role) and `jane@example.com` / `ilikecode` (regular account). These
credentials are local test fixtures only. The seed script resolves the worker
Wrangler config automatically (same default as `wrangler-env.ts`), so
`node tools/seed-test-data.ts --local` works without extra flags.

## Local limitations

- Vectorize bindings are not emulated locally; capability search uses the
  offline ranker when `WRANGLER_IS_LOCAL_DEV` is set (normal for `npm run dev`).
- `/mcp` returns **401** without OAuth; use browser login or MCP E2E tests for
  authenticated MCP checks.
