# Production rollback

Operator runbook for a bad production deploy of the product fleet. This is not
disaster recovery: if D1 or Durable Object **data** is wrong, use
[Disaster recovery](./disaster-recovery.md).

Production is five interdependent scripts (`kody-production`, `kody-platform`,
`kody-runtime`, `kody-jobs`, `kody-highlight`). Origin owns **zero** Durable
Object classes ([ADR 0034](./decisions/0034-origin-owns-no-durable-objects.md))
and binds platform/runtime classes cross-script. D1 migrations are forward-only.
Do not treat “revert the commit and let deploy.yml run” as the fast path.

`.github/workflows/deploy.yml` deploys **jobs** and **highlight** first
(parallel), then the production job applies `APP_DB` / `AUDIT_DB` migrations and
uploads **platform**, then **runtime**, then **origin**, then health-checks and
the origin-only execute smoke. Concurrency group `deploy-production` queues
rather than cancelling: a mid-sequence cancel leaves new schema with old code or
mismatched Durable Object bindings. Do not cancel a running production deploy.

## 1. Decide fast

Identify the **bad SHA** (GitHub Actions deploy, Sentry release, or `commitSha`
/ `commit` on a health endpoint). Then:

| Symptom                                                                | First action                                                                                                                                                                                                                                                    |
| ---------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Origin `/health` failing; platform and runtime health ok               | Treat as origin. UI-only deploys skip platform, runtime, and jobs — Path A on `kody-production` is the usual fix after the Path A safety checks.                                                                                                                |
| One of platform / runtime / jobs / highlight health failing; others ok | Treat as that script. Path A on that `--name` after the Path A safety checks. Roll a callee without origin only when origin's health and UI still work.                                                                                                         |
| All product workers failing or returning mixed SHAs                    | Coordinated Path A in [rollback order](#rollback-order) after the Path A safety checks. If any check fails, Path B.                                                                                                                                             |
| `POST /__maintenance/execute-smoke` failing; `/health` ok              | Origin `KodyFetchGateway` only. The smoke is **origin-only** (`scope: "origin-only"`). It does not prove MCP `execute` (that gateway lives on `kody-platform`). Path A origin if the smoke started failing on this deploy and Path A is safe; otherwise Path B. |
| Elevated Sentry errors after deploy; health green                      | Confirm the Sentry release SHA matches `/health`. If the errors are UI/Remix, Path A origin. If they are MCP, mailbox, or package-runtime, include platform and/or runtime. If a D1 or Durable Object migration shipped with the SHA, Path B.                   |
| Bad UI only (layout, copy, client bundle); APIs and MCP fine           | Path A on `kody-production` after confirming the SHA did not include a D1 or Durable Object migration.                                                                                                                                                          |

Verification (expect JSON `ok` / `status: "ok"` and the SHA you intend to be
live):

```sh
npm run control-kody -- health --origin https://kody.codes --sha <sha>
```

```sh
curl --fail --silent --show-error --header "Accept: application/json" \
  https://kody.run/__runtime/health
```

Platform has no public product hostname. Curl `GET /__platform/health` on the
`kody-platform` workers.dev URL from the last successful deploy log (CI writes
that URL as the healthcheck target).
`npx wrangler deployments status --name kody-platform` shows the live version if
you need to find it.

```sh
# Replace PLATFORM_WORKERS_DEV with that host, no trailing slash.
curl --fail --silent --show-error --header "Accept: application/json" \
  "${PLATFORM_WORKERS_DEV}/__platform/health"
```

Execute smoke (origin-only; bearer is GitHub secret
`CAPABILITY_REINDEX_SECRET`):

```sh
curl --silent --show-error --location --max-time 30 \
  -X POST \
  -H "Authorization: Bearer ${CAPABILITY_REINDEX_SECRET}" \
  -H "Accept: application/json" \
  https://kody.codes/__maintenance/execute-smoke
```

A passing body is `ok: true`, `result: 42`, `scope: "origin-only"`. Jobs and
highlight have no public hostname; CI healthchecks their workers.dev `/health`
from the deploy log (`ok` plus `commit`, not `commitSha`).
[status.kody.codes](https://status.kody.codes) probes origin, `kody.run` runtime
health, MCP OAuth challenge, and jobs over a service binding.

## 2. Path A — Cloudflare version rollback (minutes)

[Cloudflare rollbacks](https://developers.cloudflare.com/workers/versions-and-deployments/rollbacks/)
create a new deployment of a stored Worker version and send 100% of traffic
there. You can only roll back to one of the 100 most recently published
versions. Kody production deploys are single-version `wrangler deploy` uploads
(no gradual split).

### Commands

From the repo root, with `CLOUDFLARE_API_TOKEN` (or `npx wrangler login`) and
`CLOUDFLARE_ACCOUNT_ID`. Syntax is from
[Wrangler Workers commands](https://developers.cloudflare.com/workers/wrangler/commands/workers/):
`VERSION_ID` is positional. There is no `--version-id` flag on
`wrangler rollback`. `--message` skips the interactive confirmation prompts.

```sh
npx wrangler versions list --name <script>
npx wrangler versions view <VERSION_ID> --name <script>
npx wrangler rollback [<VERSION_ID>] --name <script> --message "rollback: <reason>"
```

Omit `VERSION_ID` only to take Wrangler's default (the version uploaded before
the latest version). Prefer an explicit id from `versions list`.

| Script    | `--name`          |
| --------- | ----------------- |
| Origin    | `kody-production` |
| Platform  | `kody-platform`   |
| Runtime   | `kody-runtime`    |
| Jobs      | `kody-jobs`       |
| Highlight | `kody-highlight`  |

`--name` alone is enough. Rollback reactivates a version already stored on
Cloudflare; it does not upload local Wrangler config. You do **not** need the
CI-generated files (`packages/worker/wrangler-production.generated.json`,
`packages/platform-worker/wrangler-production.generated.json`,
`packages/runtime-worker/wrangler-production.generated.json`,
`packages/jobs-worker/wrangler-production.generated.json`). Those generators
(`tools/ci/production-resources.ts`, `tools/ci/platform-worker-config.ts`,
`tools/ci/runtime-worker-config.ts`, `tools/ci/jobs-worker-resources.ts`) exist
to inject resource ids and to pin `env.production.name` so a deploy with
`--env production` does not suffix `-production` onto platform/runtime/jobs.

Do **not** pass `--env production` without `--name`. Committed configs use named
envs (`env.production` in each `packages/*/wrangler.jsonc`). Wrangler suffixes
`-<env>` onto the top-level `name` unless that env pins `name` or you pass
`--name`. Origin's committed name is `kody`, so `--env production` without
`--name` targets `kody-production` (correct). The same pattern against
`packages/platform-worker/wrangler.jsonc` targets `kody-platform-production`
(wrong). CI avoids that by pinning `env.production.name` in the generated
configs and by passing `--name` on platform, runtime, jobs, and highlight
uploads.

Avoid `node ./wrangler-env.ts rollback …`: `wrangler-env.ts` injects
`--env production` when `--env` is absent.

### What a rollback restores

A Worker version includes that version's **code, bindings, and vars**. Rolling
back therefore reverts any plain Worker var shipped with the bad version
(including `APP_COMMIT_SHA`, which is why `/health` SHA changes). Cloudflare
does **not** roll back connected resource **data** (D1 rows, KV keys, R2
objects, Durable Object storage). Secrets are not vars: if secrets changed since
the target version, Wrangler asks for extra confirmation — see
[When Path A is not safe](#3-when-path-a-is-not-safe).

[Cloudflare rollback limits](https://developers.cloudflare.com/workers/versions-and-deployments/rollbacks/):
the API refuses the rollback when a Durable Object class lifecycle change (via
`exports` or the legacy `migrations` array) sits between the live version and
the target, or when the target version binds an R2 bucket, KV namespace, or
queue that no longer exists.

### Rollback order

`.github/workflows/deploy.yml` uploads platform, then runtime, then origin
(after jobs/highlight). Roll the product trio in **reverse of those uploads**:

1. `kody-production` (origin — public caller)
2. `kody-runtime`
3. `kody-platform`
4. `kody-jobs` and `kody-highlight` only if they are implicated

Origin binds platform and runtime Durable Objects cross-script (`script_name`)
and binds `RUNTIME_WORKER`, `JOBS`, and `HIGHLIGHT`. A new caller talking to an
old callee is the failure mode (new RPC the old script does not export). Rolling
the caller first leaves new callees accepting the rolled-back caller's
expectations. Rolling a callee first leaves new origin talking to old
platform/runtime.

If only one script is implicated and origin's health/UI still match the intended
SHA, roll that one script.

Re-check health after each script, not only at the end.

## 3. When Path A is not safe

Skip Path A and use Path B (or disaster recovery) in these cases.

### (a) The bad deploy included a Durable Object migration

Look at the bad SHA:

```sh
git diff <good>..<bad> -- \
  packages/worker/wrangler.jsonc \
  packages/platform-worker/wrangler.jsonc \
  packages/runtime-worker/wrangler.jsonc \
  packages/jobs-worker/wrangler.jsonc \
  tools/ci/durable-object-baseline.json \
  tools/ci/do-deletion-allowlist.json
```

Any new or changed `new_sqlite_classes`, `transferred_classes`, or
`deleted_classes` tag (the legacy `migrations` array in those wrangler files) is
a class lifecycle change. Cloudflare **refuses** a rollback that crosses it.
Applying a reverse transfer or a `deleted_classes` tag to “undo” a transfer
strands or destroys objects. `transferred_classes` is one-shot; the
[platform](./architecture/platform-worker-migration-runbook.md),
[runtime](./architecture/runtime-worker-migration-runbook.md), and
[jobs](./architecture/jobs-worker-migration-runbook.md) runbooks forbid a second
transfer or `deleted_classes` for transferred names.

`npm run deploy-guardrails:check` (`tools/check-deploy-guardrails.ts`) protects
the reviewed baseline in `tools/ci/durable-object-baseline.json`: it rejects
removal, rename, or class-list edits of protected `new_sqlite_classes` and
`transferred_classes` tags, and it rejects Durable Object binding identity
changes (`name`, `class_name`, `script_name`, `environment`). Every
`deleted_classes` tag must match `tools/ci/do-deletion-allowlist.json` exactly.
That check is the code-review gate that keeps an accidental class deletion off
`main`. It does **not** make Path A safe after a reviewed migration has already
applied in production. Forward-fix (Path B). If objects were deleted, that is
[disaster recovery](./disaster-recovery.md), not rollback.

Kody still uses the legacy `migrations` array, not Wrangler `exports`.

### (b) The bad deploy included a D1 migration

```sh
git diff <good>..<bad> -- \
  packages/worker/migrations \
  packages/jobs-worker/migrations \
  tools/migration-ledger.json
```

`tools/check-migrations.ts` and `tools/migration-ledger.json` are append-only:
applied files cannot be edited, renamed, or deleted, and the ledger hash must
match the SQL. D1 has no down-migrations — Wrangler can create, list, and apply
remaining `.sql` files
([D1 migrations](https://developers.cloudflare.com/d1/reference/migrations/)).

Code rollback is compatible with an already-applied migration **only** when the
SQL is additive (new table, new nullable/defaulted column, new index) and the
older Worker ignores the new objects. Read the migration file named in the
ledger diff. `DROP TABLE` / `DROP COLUMN` / rename / tighter CHECK / NOT NULL
without a default is not additive: old code will error or write the wrong shape.

When it is not additive: ship a **forward-fix** migration on `main` (Path B)
that restores compatibility. Do not run D1 Time Travel as a routine rollback.
Time Travel is an in-place restore to a bookmark in the last 30 days
([D1 Time Travel](https://developers.cloudflare.com/d1/reference/time-travel/))
and is the disaster path in [disaster-recovery.md](./disaster-recovery.md),
which also records that D1 has no non-destructive clone.

`APP_DB` / `AUDIT_DB` apply in the production job before origin/platform/runtime
upload. `JOBS_DB` applies in `deploy-jobs-worker` before the jobs upload.

### (c) Secrets rotated in the same window

If `COOKIE_SECRET`, `SECRET_STORE_KEY`, or the OIDC signing pair rotated with or
just before the bad deploy, Path A puts old code against new secret values (or
prompts you to proceed despite changed secrets). That invalidates sessions or
bricks saved-secret ciphertext. Follow [Secret rotation](./secret-rotation.md)
and Path B; do not confirm Wrangler's “secrets have changed” prompt unless you
intend that pairing.

## 4. Path B — forward fix via `main`

Use Path B when Path A is unsafe, when you need a schema or Durable Object
forward-fix, or when you want Git history and CI to match what is live.

1. Open a revert PR or a fix PR against `main`.
2. ✅ Validate must succeed on that `main` push (same gate as
   `npm run validate`: format, lint, typecheck, Node/Workers tests, Playwright
   E2E, MCP E2E, worker builds, startup, primitives, migrations, deploy
   guardrails, docs checkers). CI Validate jobs time out at 10–15 minutes (E2E
   15).
3. 🚀 Deploy (production) then runs because Validate completed on `main`.
   `sha-guard` deploys **only** the current `origin/main` HEAD. Path-filtered
   push deploys skip unchanged workers; the production job timeout is 20
   minutes, jobs/highlight 8 minutes each. Wall time is one Validate cycle plus
   one Deploy cycle. The deploy job applies `APP_DB` / `AUDIT_DB` migrations,
   uploads platform → runtime → origin, health-checks, and runs execute smoke.

`workflow_dispatch` on `.github/workflows/deploy.yml` has **no inputs**. It is
allowed only when `github.ref_name == 'main'`. `sha-guard` compares the
dispatched `github.sha` to `origin/main` HEAD and **skips the deploy** when they
differ — you cannot dispatch an old SHA. Manual dispatch on current `main` HEAD
forces origin, platform, runtime, jobs, highlight, the DR backup control plane,
the status worker, and the nx-cache worker.

To put a known-good commit live through Path B, make that commit `main` HEAD
(revert or fix-forward), wait for Validate, then either let the `workflow_run`
deploy proceed or dispatch Deploy on that HEAD.

## 5. After any rollback

1. Re-run the [verification commands](#1-decide-fast) against the SHA you
   restored (or the Path B SHA). Include execute smoke when origin moved.
2. Check `/admin/insights` for error-rate and delivery charts.
3. Confirm Sentry: production deploys upload source maps under `APP_COMMIT_SHA`.
   Events after Path A should attach to the restored version's `APP_COMMIT_SHA`
   var (same value `/health` reports as `commitSha`).
4. Post a **manual note** in Discord. `kody:@kentcdodds/discord/send-shipped-pr`
   is the merged-PR summary convention; there is no rollback equivalent.
5. If the incident left a leftover (shim, dual-write, a later `deleted_classes`
   tag, an extra column), open a `Cleanup:` issue per
   [Cleanup after migrations](./cleanup-after-migrations.md).
6. If the incident involved data (D1 apply, Time Travel, Durable Object storage,
   Mailbox), add a row to the
   [live evidence log](./disaster-recovery.md#live-evidence-log) in that
   document's table format (UTC date, lane proven).

## 6. Rehearsal

Run once before a launch and quarterly. Do **not** pass `wrangler rollback`
during rehearsal.

- [ ] `CLOUDFLARE_API_TOKEN` (or an operator token) has `Workers Scripts:Edit`.
      CI's production token is documented in
      [setup-manifest.md](./setup-manifest.md) (Workers deploy + D1 edit);
      [Cloudflare offerings](./cloudflare-offerings.md) lists
      `Workers Scripts:Edit` as the deploy permission. `wrangler rollback` needs
      that Edit scope.
- [ ] `CLOUDFLARE_ACCOUNT_ID` is the production (Kody) account, not the DR
      account.
- [ ] For each script, list versions and record the **current** version id:

```sh
npx wrangler versions list --name kody-production
npx wrangler versions list --name kody-platform
npx wrangler versions list --name kody-runtime
npx wrangler versions list --name kody-jobs
npx wrangler versions list --name kody-highlight
```

- [ ] `npx wrangler deployments status --name kody-production` (and the other
      four names) matches those current ids.
- [ ] Origin health SHA matches `origin/main` HEAD:
      `npm run control-kody -- health --origin https://kody.codes --sha $(git rev-parse origin/main)`
- [ ] Runtime: `curl` `https://kody.run/__runtime/health`.
- [ ] Platform: `curl` `/__platform/health` on the workers.dev host from the
      last deploy.
- [ ] Confirm you can locate `CAPABILITY_REINDEX_SECRET` for execute smoke
      without putting it in chat or tickets.
- [ ] Confirm Path A safety on the last deploy: no Durable Object migration tag,
      no non-additive D1 migration, no secret rotation in the same window.

## Related

- [Architecture — production worker fleet](./architecture/index.md#production-worker-fleet)
- [Platform worker migration runbook](./architecture/platform-worker-migration-runbook.md)
- [Runtime worker migration runbook](./architecture/runtime-worker-migration-runbook.md)
- [Jobs worker migration runbook](./architecture/jobs-worker-migration-runbook.md)
- [Disaster recovery](./disaster-recovery.md)
- [Secret rotation](./secret-rotation.md)
- [Authoring D1 migrations](./setup/migrations.md)
- [control-kody](./control-kody.md)
