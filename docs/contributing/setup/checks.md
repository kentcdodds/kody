# Checks

Husky hooks, `npm run validate`, and the test commands that gate commits and
pushes. See the [setup index](./index.md) for the other setup pages.

- `git commit` runs the Husky `pre-commit` hook, which formats staged
  JavaScript/TypeScript/JSON/Markdown/CSS files with `oxfmt`, applies
  `oxlint --fix` to staged JavaScript/TypeScript files, runs `npm run typecheck`
  for the repo, and runs `npm run migrations:check` before the commit is
  created.
- `git push` runs the Husky `pre-push` hook, which executes `npm run test:push`
  (`CI=1` `test:node` + `test:workers` + Playwright E2E) so pushes are blocked
  when those suites fail. Those are the same Nx targets GitHub Actions runs, so
  a remote-cache hit is possible after push. Cursor Cloud Agent VMs keep
  Cursor's hook dispatcher as `core.hooksPath` and compose Husky through
  `npm run hooks:ensure` (`prepare` runs it after `husky`; Cloud Agent
  environment `start` should run it too) so `pre-push` still reaches `.husky/_`
  — see [cloud-agents.md](../cloud-agents.md#git-hooks). Vitest's default
  `testTimeout` is 20s so the workers pool's first Durable Object RPC in a file
  (~10s) does not fail the default budget (see
  [decision 0011](../decisions/0011-workers-unit-pool-harness.md)); the push
  gate also sets `CI=1` so worker count, Playwright retries, and Nx cache hashes
  match GitHub Actions.
- Because the commit hook already enforces formatting, lint fixes, and
  typechecking, agents do not need to run those checks separately before every
  commit unless they want earlier feedback or are validating a larger change set
  before opening a PR.
- Push-time hooks intentionally stop short of `npm run validate`; MCP E2E and
  repo-wide format checks remain explicit checks because they are heavier than
  the push gate.
- `npm run validate` is the single authoritative local gate. It is read-only and
  executes `format:check`, `lint`, `typecheck`, `test:node`, `test:workers`,
  Playwright E2E, MCP E2E, `backup:build`, `status:build`, `nx-cache:build`,
  `jobs:build`, `runtime:build`, `platform:build`, `primitives:check`,
  `migrations:check`, `deploy-guardrails:check`, `docs:check-temporal`, and
  `docs:check-decisions` in parallel, reporting every failure (sibling checks
  are not aborted on the first failure, including when one of the two docs
  checks fails). The unit-test and Playwright legs set `CI=1` so timeouts,
  worker limits, and Nx cache hashes match the contended parallel layout used in
  GitHub Actions. CI runs the same checks as parallel jobs (🧹 Static, 🧪 Node,
  ☁️ Workers, 🔌 MCP, 🎭 E2E, aggregated by ✅ Validate). If `npm run validate`
  passes locally, CI will pass. When `NX_SELF_HOSTED_REMOTE_CACHE_SERVER` and
  `NX_SELF_HOSTED_REMOTE_CACHE_ACCESS_TOKEN` are set, Nx uploads those task
  artifacts to `https://nx-cache.kody.codes` so CI can reuse them (see
  [decision 0019](../decisions/0019-self-hosted-nx-remote-cache.md) and
  [`packages/nx-cache/readme.md`](../../../packages/nx-cache/readme.md)).
- `npm run deploy-guardrails:check` protects reviewed Durable Object migration
  history and bindings in both Wrangler configs, requires exact allowlisting for
  class deletion, and rejects destructive Cloudflare CLI operations in
  automatically triggered GitHub Actions jobs.
- `npm run validate:fix` runs `format` + `lint:fix` and is the explicit opt-in
  for mutating auto-fixes. It is never required to pass `validate`.
- `npm run format` applies formatting updates on its own.
- `npm run test:push` runs the same `test:node`, `test:workers`, and Playwright
  E2E suites enforced by the Husky `pre-push` hook and by the CI Node / Workers
  / E2E jobs.
- `npm run test:e2e:run` ensures Playwright Chromium is installed before the
  suite starts, so `npm run validate` and `npm run test:push` self-heal on a
  fresh machine.
- Use `npm run test:e2e:install` when you want to prefetch Playwright browsers
  ahead of time instead of waiting for the first E2E run. CI caches
  `~/.cache/ms-playwright` and runs `test:e2e:ensure`, so a lockfile-matching
  cache hit skips the download and never runs `apt-get` (`--with-deps` is
  local-only; `apt-get update` can hang the E2E job past the 15-minute timeout).
- `npm run test:e2e:run` runs the Playwright suite through Nx and depends on a
  cached `worker:prepare-e2e-env` target for `.env` bootstrap plus an uncached
  `worker:prepare-playwright` target that checks the local Chromium install.
- `npm run test:mcp` runs MCP server E2E tests and also depends on the cached
  `worker:prepare-e2e-env` target, which writes `packages/worker/.env` from
  `.env.example` when needed and backfills `COOKIE_SECRET` before the test run.
