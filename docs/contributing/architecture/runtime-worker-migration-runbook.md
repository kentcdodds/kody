# Runtime worker migration runbook

How to move the package runtime lane from the main `kody` Worker into the
`kody-runtime` Worker (`packages/runtime-worker/`) in production, per
[ADR 0016](../decisions/0016-mono-worker-extraction.md). The genuinely risky
step is the one-time Durable Object **script migration**: the storage of
`StorageRunner`, `RunLog`, `PackageRealtimeSession`, and
`PackageServiceInstance` moves from the `kody` script to the `kody-runtime`
script via a Wrangler `transferred_classes` migration.

> **Warning:** the implementation session that authored this document must NOT
> execute these production steps. The runbook is executed by an operator (the
> parent session) after preview verification and PR merge.

## Ownership after the split

| Concern                                                                       | Owner                                                                       |
| ----------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| Package-app origin (`PACKAGE_APP_BASE_URL`, `kodyapps.dev`) zone routes       | `kody-runtime`                                                              |
| Inline package-app serving (`/apps/...` on the app origin)                    | `kody-runtime` (forwarded by main via the `RUNTIME_WORKER` service binding) |
| Package invocation API                                                        | `kody-runtime` (forwarded by main)                                          |
| `DynamicCallableWorkflow` (Cloudflare Workflow)                               | `kody-runtime` (main binds it cross-script)                                 |
| `StorageRunner`, `RunLog`, `PackageRealtimeSession`, `PackageServiceInstance` | `kody-runtime` (main binds them cross-script)                               |
| `UserMeter` and every other Durable Object, app, MCP, OAuth, email, jobs      | `kody` (runtime binds what it needs cross-script)                           |
| `APP_DB` / `AUDIT_DB` / KV / R2 / queues / Vectorize / AI                     | Shared resources; each worker binds directly (no RPC proxying)              |

## Migration configuration

Committed in `packages/runtime-worker/wrangler.jsonc` (production applies it on
the first `kody-runtime` deploy; the exact transfer set is protected by
`tools/ci/durable-object-baseline.json`). The committed `from_script: "kody"` is
rewritten by `tools/ci/runtime-worker-config.ts` to the actual deployed main
script name (`kody-production` — wrangler appends the environment to the
top-level name) at deploy time:

```jsonc
"migrations": [
	{
		"tag": "v1",
		"transferred_classes": [
			{ "from": "StorageRunner", "from_script": "kody", "to": "StorageRunner" },
			{ "from": "RunLog", "from_script": "kody", "to": "RunLog" },
			{ "from": "PackageRealtimeSession", "from_script": "kody", "to": "PackageRealtimeSession" },
			{ "from": "PackageServiceInstance", "from_script": "kody", "to": "PackageServiceInstance" }
		]
	}
]
```

Cloudflare requirements for a `transferred_classes` migration:

- The source script (`kody-production`) must still exist and must still contain
  the migration history that created the classes; the transfer removes them from
  the source script's Durable Object namespace registry.
- The destination script must export classes under the `to` names.
- The source script must stop exporting/serving the classes in the **same
  coordinated deploy window** — after the transfer, DO requests routed through
  the old script's namespaces fail.
- Existing DO ids, storage, and alarms move with the class. In-flight requests
  against the old namespace during the switch can error; run at a quiet time.

## Workflow cutover caveat

`DynamicCallableWorkflow` moves to `kody-runtime` as a **new** Cloudflare
Workflow (`kody-runtime-dynamic-callable-workflows`) — Workflows cannot be
transferred between scripts. Any workflow instances still running on the old
`kody`-owned workflow at cutover are orphaned once the main worker stops
exporting a workflow binding for them; deploy at a quiet time and treat
in-flight dynamic callable runs at the cutover moment as lost (they surface as
failed runs).

## Coordinated production deploy order

The merged main-branch deploy workflow (`.github/workflows/deploy.yml`) encodes
this order; the operator's job is to merge and watch, not to run wrangler by
hand.

1. **Preview verification (before merging).** The PR's preview deploy creates a
   fresh worker pair (`kody-pr-<n>` and `kody-pr-<n>-runtime`). Verify:
   - both healthchecks passed in the preview workflow (`/health` on main,
     `/__runtime/health` on runtime);
   - a package app loads on the preview origin (`/apps/<user>/<package>`);
   - a package invocation runs end to end (create a run, watch its RunLog stream
     complete). Preview cannot rehearse the `transferred_classes` migration
     itself (preview pairs are created fresh with `new_sqlite_classes`); the
     transfer is exercised for the first time in production, which is why the
     deploy order below matters.
2. **Ensure the package-app zone is free for `kody-runtime` (one-time, just
   before merging).** Production serves `kodyapps.dev` via **zone routes** on
   the runtime Worker (apex + `*.kodyapps.dev/*`), never a Workers custom domain
   in that zone — publishing a zone's route table detaches any custom domain
   there. If the main worker still owns a leftover `kodyapps.dev` custom domain
   or zone routes from before the split, remove them in the Cloudflare dashboard
   (Workers & Pages → `kody` → Settings → Domains & Routes) so the first
   `kody-runtime` deploy can publish the package-app routes. Between that detach
   and the runtime deploy, package-app traffic on `kodyapps.dev` is unserved —
   merge promptly. Later deploys find the zone routes already on `kody-runtime`.
3. **Merge the PR.** The production deploy workflow then:
   1. generates the runtime config from the provisioned main config
      (`tools/ci/runtime-worker-config.ts`);
   2. syncs secrets to both workers;
   3. applies D1 migrations (shared databases, applied once);
   4. **deploys `kody-runtime` first** — this applies the `v1`
      `transferred_classes` migration, moving the four classes' storage out of
      `kody`. From this moment the still-running old `kody` deployment serves
      runtime traffic against namespaces that have moved; the window until step
      5 completes must be short and is why the two deploys are consecutive steps
      in one job. There is deliberately no maintenance-mode traffic gate: the
      accepted risk (per ADR 0016) is that runtime requests hitting the old
      `kody` deployment during this seconds-long window error and surface as
      failed runs/invocations, which is why the deploy runs at a quiet time;
   5. **deploys `kody` second** with the config that binds the four classes
      cross-script (`script_name: "kody-runtime"`) plus the `RUNTIME_WORKER`
      service binding, and stops routing runtime requests in-process;
   6. healthchecks `kody` (`/health`) and `kody-runtime` (`/__runtime/health`),
      then runs the execute smoke check.
4. **Post-deploy verification.**
   - Load a production package app on
     `https://{username}.kodyapps.dev/packages/{kodyId}/...` (the apex only
     redirects; it does not serve package code).
   - Run a package invocation; confirm the run appears with streaming logs
     (proves RunLog storage transferred, not recreated empty).
   - Open an existing pre-migration run's logs (proves old DO storage moved).
   - Check Sentry for both workers.

## Manual execution (only if the workflow cannot run)

From a checkout of the merged commit, with `CLOUDFLARE_API_TOKEN` set (plus the
secret values used below — mirror the `🔐 Sync Cloudflare Secrets` steps in
`.github/workflows/deploy.yml`, which are the source of truth for the exact
secret lists). The steps mirror the workflow order: generate configs, sync
secrets to both workers, apply D1 migrations, then deploy runtime → main.

```sh
node tools/ci/production-resources.ts ensure --out-config packages/worker/wrangler-production.generated.json
node tools/ci/runtime-worker-config.ts generate \
  --env production \
  --main-config packages/worker/wrangler-production.generated.json \
  --worker-name kody-runtime \
  --main-worker-name kody \
  --out-config packages/runtime-worker/wrangler-production.generated.json

# Sync secrets to both workers (full secret set to main; runtime-lane
# allowlist to kody-runtime — see deploy.yml for the current lists):
node tools/ci/sync-worker-secrets.ts --env production \
  --config packages/worker/wrangler-production.generated.json \
  --set-from-env COOKIE_SECRET ... # copy the main-worker flag list from deploy.yml
node tools/ci/sync-worker-secrets.ts --env production \
  --config packages/runtime-worker/wrangler-production.generated.json \
  --set-from-env COOKIE_SECRET \
  --set-from-env-optional SECRET_STORE_KEY \
  --set-from-env-optional AI_GATEWAY_ID \
  --set-from-env-optional SENTRY_DSN \
  --set-from-env-optional CLOUDFLARE_API_TOKEN

# Apply shared D1 migrations once (both workers bind the same databases):
node ./wrangler-env.ts d1 migrations apply APP_DB --remote --config packages/worker/wrangler-production.generated.json
node ./wrangler-env.ts d1 migrations apply AUDIT_DB --remote --config packages/worker/wrangler-production.generated.json

npm run deploy -- --config packages/runtime-worker/wrangler-production.generated.json
npm run deploy -- --config packages/worker/wrangler-production.generated.json
```

## Rollback

- **Runtime deploy failed before the migration applied:** nothing moved; the old
  `kody` deployment still owns the classes. Fix and retry.
- **After the transfer applied:** roll _forward_ on the runtime worker (redeploy
  a fixed `kody-runtime`). Do not attempt to transfer the classes back to `kody`
  under incident pressure — a reverse `transferred_classes` migration is
  possible but is a second risky migration; it needs its own reviewed config
  change (the deploy guardrails intentionally refuse unreviewed migration
  edits).
- The main worker can always be rolled back independently as long as its config
  keeps the cross-script bindings.
