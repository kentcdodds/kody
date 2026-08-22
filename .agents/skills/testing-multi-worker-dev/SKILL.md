---
name: testing-multi-worker-dev
description:
  How to run and test kody's multi-worker local dev (main kody worker +
  kody-runtime secondary config), including known wrangler multi-config pitfalls
  (secondary worker env-name suffix, remote AI binding, .env secrets not
  propagated) and how to verify runtime-worker forwarding.
---

# Testing multi-worker local dev (kody + kody-runtime)

## Basics

- Node 26 required: `export PATH="$HOME/.nvm/versions/node/v26.7.0/bin:$PATH"`.
- Run `npm run dev` in tmux; it starts the client watcher, the mock Cloudflare
  API worker, and `wrangler dev --local` with TWO `--config`s (main
  `packages/worker/wrangler.jsonc` + `packages/runtime-worker/wrangler.jsonc`)
  in one miniflare. Default port 3742; the CLI picks the next free port if taken
  — stale `workerd` processes commonly hold 3742, so `pkill -9 workerd` before
  restarting.
- Local dev uses `--env production` (CLOUDFLARE_ENV defaults to production in
  `wrangler-env.ts`).
- Migrate + seed login: `npm run migrate:local` then
  `node tools/seed-test-data.ts --local` → `kody@example.com` / `ilikecode`
  (admin) and `jane@example.com` / `ilikecode`.
- Healthchecks: main `GET /health` → `{"ok":true,...}`; runtime worker serves
  `GET /__runtime/health` (only reachable through the service binding locally —
  hitting it on the main port should 404).

## Known wrangler multi-config pitfalls (handled by a generated dev config)

Wrangler applies `--local`, `--var`, and `.env`-derived secrets only to the
PRIMARY config, registers each worker under `<name>-<env>`, and treats a
secondary config's `ai` binding as always-remote (dev fails to boot with "Failed
to start the remote proxy session"; `"remote": false` is NOT enough).

`wrangler-env.ts` therefore never passes the committed runtime config to
`wrangler dev` directly: `tools/local-runtime-dev-config.ts` generates
`packages/runtime-worker/wrangler-local-dev.generated.json` (gitignored) on each
dev start, which pins the secondary's registered name to `kody-runtime`,
rewrites its `script_name: "kody"` refs to the primary's dev name
(`kody-<env>`), drops the `ai` binding, and injects `APP_BASE_URL`,
`COOKIE_SECRET`, `SECRET_STORE_KEY`, and `WRANGLER_IS_LOCAL_DEV` from the dev
process env. If runtime-owned paths 503 with `Worker "kody-runtime" not found`
or the runtime worker 500s on missing vars, inspect that generated file first.

## Jobs-worker Durable Object pitfall (boot failure)

With the jobs-worker extraction (ADR 0016), `npm run dev` may fail with
`service core:user:kody-production: Uncaught TypeError: Class extends value undefined is not a constructor or null`
(in miniflare's `createDurableObjectWrapper`) and "The Workers runtime failed to
start". Root cause: local dev (`--env production`) inherits the TOP-LEVEL
migrations chain in `packages/worker/wrangler.jsonc`, which still nets out
`JobManager` as a live DO class on the main script (v6 adds
JobManager+JobRunner, v9 only deletes JobRunner) — but `JobManager` is not
exported from `packages/worker/src/index.ts` (it lives in
`packages/jobs-worker`, which uses a `transferred_classes` migration from
`kody-production`). Miniflare replays the full chain fresh and tries to wrap the
missing class. The fix is a migration chain without the v6/v9 pair (matching
`preview`/`test`); if the error reappears, check that the top-level chain in
`packages/worker/wrangler.jsonc` does not create classes the main script does
not export.

## Verifying forwarding

- Unauthenticated `GET /@<user>/packages/<anything>` on the main port: 302 →
  `/login` proves the runtime lane handled it (broken binding gives 503
  instead).
- `POST /@<user>/api/package-invocations/x/y` without bearer → 401
  `{"ok":false,"error":{"code":"unauthorized"}}` from the runtime worker.
- Binding status line in dev output:
  `env.RUNTIME_WORKER (...) Worker local [connected]` vs `[not connected]`.
- Beware: logged-in package-app requests redirect to the real `https://kody.run`
  (production `PACKAGE_APP_BASE_URL`) — don't follow the handoff into prod.
