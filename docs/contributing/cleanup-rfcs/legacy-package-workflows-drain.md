# RFC: retire the legacy `PackageWorkflowEntrypoint` drain

**Status:** Draft for discussion. No code changes proposed in this PR.
**Owner:** TBD. **Related commit:** `1c23974` — "Remove legacy per-package
Workflow path; hub-backed `workflows.create` is the only workflow creation
mechanism".

## Summary

Commit `1c23974` removed every code path that creates new instances on the
`PACKAGE_WORKFLOWS` Cloudflare Workflow binding. The class
(`PackageWorkflowEntrypoint`), its registration in `wrangler.jsonc`, and the
provisioning logic in `tools/ci/` are still present solely so that any Workflow
Durable Object instances scheduled before that deploy can finish (or be marked
terminal). Once we are confident that no instances remain, we can delete the
class, the binding, the test module, and the CI plumbing.

This document inventories what is left, defines a "drain complete" signal,
proposes the exact removal sequence, and recommends a timing rule.

## Inventory of the legacy surface

The following exist only to support drain:

| Path                                                                 | Lines / role                                                                                                                                                                                                                                                                                                                                                                                                                    |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/worker/src/package-runtime/package-workflows.ts`           | `PackageWorkflowEntrypointBase` (≈lines 1086–1143), the Sentry-wrapped export `PackageWorkflowEntrypoint` (lines 1145–1148), and the helpers used only by the v1 payload path (`PackageWorkflowPayload`, `validatePackageWorkflowPayload`, `createPackageWorkflowPayload`, `createPackageWorkflowInstanceId`). The rest of the module (≈900 lines) backs `DynamicCallableWorkflow` / `createDynamicCallableWorkflow` and stays. |
| `packages/worker/src/package-runtime/package-workflows.node.test.ts` | Tests at lines 687–825 (`PackageWorkflowEntrypoint sleeps for future runAt …`, `PackageWorkflowEntrypoint invokes already-due package workflows …`) cover the legacy entrypoint. The remaining ≈680 lines cover the still-live dynamic workflow code.                                                                                                                                                                           |
| `packages/worker/src/index.ts`                                       | Imports `PackageWorkflowEntrypoint` from `package-workflows.ts` and re-exports it (lines 14, 69) so Wrangler can bind the class.                                                                                                                                                                                                                                                                                                |
| `packages/worker/wrangler.jsonc`                                     | A `PACKAGE_WORKFLOWS` workflow binding under `env.production`, `env.preview`, and `env.test` (lines 99–102, 202–205, 305–308) pointing at `class_name: "PackageWorkflowEntrypoint"`. Workflow names: `kody-package-workflows`, `kody-preview-package-workflows`, `kody-test-package-workflows`.                                                                                                                                 |
| `packages/worker/worker-configuration.d.ts`                          | Generated `PACKAGE_WORKFLOWS` field on `Env` (line 39). Re-runs of `wrangler types` will drop this once the binding is removed.                                                                                                                                                                                                                                                                                                 |
| `tools/ci/resource-utils.ts`                                         | `writeGeneratedWranglerConfig` accepts `packageWorkflowName`, locates the `PACKAGE_WORKFLOWS` binding in the generated env, and rewrites its `name` (lines 282–344). `fail()`s loudly if the binding is missing.                                                                                                                                                                                                                |
| `tools/ci/resource-utils.node.test.ts`                               | Asserts the missing-binding error string (lines ~110–116).                                                                                                                                                                                                                                                                                                                                                                      |
| `tools/ci/preview-resources.ts`, `tools/ci/production-resources.ts`  | Compute the per-environment workflow name and feed it to `writeGeneratedWranglerConfig`.                                                                                                                                                                                                                                                                                                                                        |
| `docs/contributing/architecture/index.md`                            | Lines 69–71 describe the binding as "legacy" drain code.                                                                                                                                                                                                                                                                                                                                                                        |
| `docs/contributing/architecture/request-lifecycle.md`                | Lines 84–87 say "no new runtime path creates instances on it".                                                                                                                                                                                                                                                                                                                                                                  |

## 1. What the drain code actually does

`PackageWorkflowEntrypointBase.run(event, step)` (in `package-workflows.ts`):

1. Validates `event.payload` against the v1 `PackageWorkflowPayload` shape via
   `validatePackageWorkflowPayload`. Anything that is not a v1 payload throws
   immediately, which causes the Workflow runtime to mark that instance
   `errored`.
2. If `payload.runAt` is in the future, calls
   `step.sleepUntil('wait until package workflow runAt', runAt)`.
3. Calls
   `step.do('invoke saved package workflow export', …, async () => { … })`,
   which invokes `invokePackageExport` with a scoped internal token
   (`tokenId: 'internal:package-workflows'`, `sources: ['package-workflow']`)
   targeting the saved package and export recorded in the payload.
4. Returns the package response (`{ status, body }`) as the workflow result.

Notably it **does not write to `workflow_runs`**. That table is populated by the
live `DynamicCallableWorkflow` path; legacy drain runs never appear there.

A repository-wide search for `env.PACKAGE_WORKFLOWS` (and `PACKAGE_WORKFLOWS:`,
`PACKAGE_WORKFLOWS.create`, etc.) returns only:

- the binding itself in `wrangler.jsonc`,
- the generated typing in `worker-configuration.d.ts`,
- the rewriter in `tools/ci/resource-utils.ts` and its test.

There is **no** worker code path that calls `env.PACKAGE_WORKFLOWS.get(…)` or
`.create(…)`. So at this point the class strictly receives Cloudflare-side
resumptions of pre-`1c23974` Workflow Durable Object instances:

- Instances that were created before the deploy and were either still queued,
  sleeping inside `step.sleepUntil`, retrying inside `step.do`, or otherwise not
  in a terminal state (`complete | errored | terminated`).
- Cloudflare may also resume an instance to honor the Workflow's configured
  retention so its final status is reachable through
  `wrangler workflows instances describe`.

In other words: the class is now a deserializer + invoker for a finite,
shrinking set of pre-existing DO instances.

## 2. How to know the drain is complete

### Signals that exist today

- **Cloudflare Workflows API / dashboard.** Each environment's binding maps to a
  real Workflow whose instances can be enumerated with
  `wrangler workflows instances list <workflow-name>`, optionally filtered by
  status. Concretely:
  - `wrangler workflows instances list kody-package-workflows --status=running`
  - `wrangler workflows instances list kody-package-workflows --status=queued`
  - `wrangler workflows instances list kody-package-workflows --status=paused`
  - `wrangler workflows instances list kody-package-workflows --status=waiting`
  - `wrangler workflows instances list kody-package-workflows --status=waitingForPause`
  - Repeat for `kody-preview-package-workflows`. (The
    `kody-test-package-workflows` binding does not run real instances in
    production.)

  Drain is complete when all of those return zero rows over a multi-day window.
  This is the **authoritative** signal.

- **Sentry.** `PackageWorkflowEntrypoint` is wrapped with
  `Sentry.instrumentWorkflowWithSentry` (`package-workflows.ts` line 1145).
  Workflow events therefore appear as Sentry transactions tagged with the
  workflow class name; the Sentry "Performance → Transactions" view filtered by
  `transaction:PackageWorkflowEntrypoint*` (or by the Workflow class attribute
  that the Sentry SDK sets) shows the rate of legacy invocations.

- **Cloudflare Worker logs.** `invokePackageExport` is called with
  `source: 'package-workflow'` and `tokenId: 'internal:package-workflows'`.
  These are also used by the live `DynamicCallableWorkflow` package path, so on
  their own they are **not** a drain-only marker. They are fine for an
  upper-bound count but cannot be used to prove "zero".

### Proposed instrumentation (recommended before removal)

Add a single explicit log line at the top of `PackageWorkflowEntrypointBase.run`
so the drain has a queryable, drain-only signal in Logpush / `wrangler tail`:

```ts
console.log(
	JSON.stringify({
		event: 'legacy_package_workflow_drain_run',
		instanceId: event.instanceId,
		userId: payload.userId,
		packageId: payload.packageId,
		workflowName: payload.workflowName,
		runAt: payload.runAt,
	}),
)
```

Once added and deployed, "no `legacy_package_workflow_drain_run` events for N
consecutive days across production _and_ preview" combined with "the Cloudflare
Workflows instances list returns zero non-terminal rows" is a sufficient signal.

This log is opt-in cheap (one structured line per resumed legacy instance) and
should remain until the class is deleted.

## 3. Removal plan

The order matters. The two hard constraints are:

- **Do not** remove the `PackageWorkflowEntrypoint` class export from the worker
  bundle while the `PACKAGE_WORKFLOWS` binding still references it in
  `wrangler.jsonc`. Wrangler will fail the deploy because the binding's
  `class_name` will not resolve.
- **Do not** remove the binding from `wrangler.jsonc` while non-terminal
  instances still exist on the Workflow. Removing the binding is what signals to
  Cloudflare that the workflow definition is going away; in-flight instances may
  then be terminated abruptly (status `terminated`, with partially executed
  `step.do` side effects).

### Step-by-step

1. **Add drain instrumentation.** Land the structured `console.log` from §2 into
   `PackageWorkflowEntrypointBase.run` and deploy to production and preview.
   This is the only code change required _before_ drain is complete.

2. **Wait for the drain criterion.** See §5.

3. **Delete the workflow definitions on the Cloudflare side first.** For each
   environment, remove or terminate any straggler instances and delete the
   workflow definition:

   ```sh
   wrangler workflows delete kody-package-workflows
   wrangler workflows delete kody-preview-package-workflows
   wrangler workflows delete kody-test-package-workflows
   ```

   Doing this _before_ the next deploy guarantees Wrangler will not see a
   resource conflict when the binding is removed. (If Cloudflare later
   re-creates a workflow on a redeploy because the binding is still present,
   re-run the delete.)

4. **Remove the binding from `wrangler.jsonc`.** Delete the three
   `PACKAGE_WORKFLOWS` entries from `env.production.workflows`,
   `env.preview.workflows`, and `env.test.workflows`. Leave the
   `DYNAMIC_CALLABLE_WORKFLOWS` entry in place. Deploy.

5. **Wrangler migration tag.** Cloudflare's `migrations` array in
   `wrangler.jsonc` tracks **Durable Object** classes (`new_sqlite_classes` /
   `deleted_classes` / `renamed_classes`). Cloudflare Workflows are managed by
   the `workflows` binding type and the `wrangler workflows` CLI surface,
   **not** by the DO migrations array. No new migration tag is required, and
   there should not be a `deleted_classes: ["PackageWorkflowEntrypoint"]` entry.
   (If a future Wrangler release changes this and starts requiring such a
   migration, the next free tag is `v17`; v16 is the highest tag in use today.)

6. **Delete the worker code.** In a follow-up PR after step 4 ships:
   - Remove the `PackageWorkflowEntrypoint` import and re-export in
     `packages/worker/src/index.ts` (lines 14 and 69).
   - Delete `PackageWorkflowEntrypointBase`, the
     `Sentry.instrumentWorkflowWithSentry`-wrapped export
     `PackageWorkflowEntrypoint`, and the v1-only helpers
     (`PackageWorkflowPayload`, `validatePackageWorkflowPayload`,
     `createPackageWorkflowPayload`, `createPackageWorkflowInstanceId` if not
     referenced by the dynamic path) from
     `packages/worker/src/package-runtime/package-workflows.ts`. Audit before
     deleting helpers — `createPackageWorkflowInstanceId` is still called by the
     `package` branch of `createDynamicCallableWorkflowInstanceId`, so it must
     stay.
   - Delete the two legacy tests in
     `packages/worker/src/package-runtime/package-workflows.node.test.ts` (lines
     687–825). Keep the rest of the file.
   - Re-run `wrangler types` so `worker-configuration.d.ts` no longer carries
     `PACKAGE_WORKFLOWS`.

7. **Update `tools/ci/`.** Same follow-up PR:
   - In `tools/ci/resource-utils.ts`, drop the `packageWorkflowName` parameter
     from `writeGeneratedWranglerConfig` and remove the lookup + rewrite block
     (lines 282–344, plus the type annotation).
   - In `tools/ci/preview-resources.ts` and `tools/ci/production-resources.ts`,
     stop computing `packageWorkflowName` and stop passing it to
     `writeGeneratedWranglerConfig`. Remove `defaultPackageWorkflowName` if it
     is no longer used.
   - In `tools/ci/resource-utils.node.test.ts`, replace the `PACKAGE_WORKFLOWS`
     missing-binding assertion (lines ~100–116) with a happy-path test, or
     delete it if the new code path no longer has a matching failure mode.

8. **Update documentation.** Same follow-up PR:
   - `docs/contributing/architecture/index.md` lines 69–71: drop the "legacy
     `PackageWorkflowEntrypoint`" sentence; the section can simply describe the
     hub-backed `DynamicCallableWorkflow`.
   - `docs/contributing/architecture/request-lifecycle.md` lines 83–87: drop the
     "still registered so in-flight Workflow Durable Objects from prior deploys
     can drain naturally" sentence.

### Suggested PR sequencing

- PR A: add drain instrumentation (§3 step 1). Small, ship immediately.
- PR B: remove binding from `wrangler.jsonc` (§3 step 4). Ship after the drain
  criterion is met (§5) and after step 3 has been performed against each
  environment.
- PR C: delete code, tests, CI plumbing, docs (§3 steps 6–8). Ship after PR B
  has been deployed and observed for at least one full deploy cycle with no
  Workflow-binding errors.

## 4. What stays forever

The DO `migrations` array in `wrangler.jsonc` is an **append-only ledger** that
Wrangler replays against the namespace on deploy. Removing or reordering
historical entries causes a "migration history mismatch" error and refuses the
deploy. The following entries describe classes that no longer exist in the
codebase:

- `v3` — `new_sqlite_classes: ["HomeConnectorSession", "HomeMCP"]`
- `v4` — `new_sqlite_classes: ["SchedulerDO"]`
- `v6` — `new_sqlite_classes: ["JobManager", "JobRunner"]` (`JobRunner` deleted
  later)
- `v7` — `deleted_classes: ["SchedulerDO"]`
- `v9` — `deleted_classes: ["JobRunner"]`
- `v15` —
  `renamed_classes: [{ from: "HomeConnectorSession", to: "RemoteConnectorSession" }]`
- `v16` — `deleted_classes: ["HomeMCP"]`

These are not worth trying to clean up. Any "tidying" attempt would either be
rejected by Wrangler (history mismatch) or, worse, get past config validation
but mismatch the live namespace state and corrupt DO routing on deploy. Treat
the migrations array as immutable history; add new tags, never edit old ones.

The `PACKAGE_WORKFLOWS` binding is **not** subject to this rule because
Workflows are not part of the DO migrations ledger. Removing the binding from
`wrangler.jsonc` (§3 step 4) is a normal config change, not a history edit.

## 5. Recommended timing

### Constraints

- `1c23974` was deployed on **2026-05-08**.
- Workflow instances created by the legacy path used
  `successRetention: '30 days'` and `errorRetention: '30 days'` in the same
  module (see `DynamicCallableWorkflow.create`, `package-workflows.ts` lines
  851–856; the legacy path used the runtime defaults but still bounded by
  Cloudflare's documented Workflow lifecycle limits, which are measured in days,
  not months). After roughly 30 days post-deploy, Cloudflare itself stops
  resuming completed instances and they fall out of the `instances list` view.
- Long-`runAt` legacy schedules are the only realistic way an instance could
  survive longer than 30 days. The legacy code path was used for
  `kody.workflows` manifest entries; in practice these were short-horizon jobs
  (timers, queue-style follow-ups), not multi-month sleeps.

### Drain criterion

Proceed with §3 step 4 (binding removal) when **all** of the following are true
for at least **30 consecutive days**:

1. `wrangler workflows instances list kody-package-workflows` and
   `wrangler workflows instances list kody-preview-package-workflows` return
   zero rows in any non-terminal status (`queued`, `running`, `paused`,
   `waiting`, `waitingForPause`).
2. The `legacy_package_workflow_drain_run` log line proposed in §2 is not
   observed in Cloudflare logs for production or preview.
3. Sentry shows no transactions for the `PackageWorkflowEntrypoint` class over
   the same window.

### Earliest realistic date

- §2 instrumentation deployed: target **2026-05-15** (≈one week after
  `1c23974`).
- 30-day quiet window starting then ends **2026-06-14**.
- Earliest binding removal (PR B): **on or after 2026-06-14**.
- Earliest code/CI/doc deletion (PR C): one deploy cycle after PR B, i.e. **on
  or after 2026-06-21**.

If non-terminal instances are still observed after 2026-06-14, extend the window
in 30-day increments and investigate any user (`payload.userId`) that keeps
appearing — it likely indicates a long-`runAt` schedule that will eventually
fire on its own. Manually `wrangler workflows instances terminate <id>` is
acceptable for one-off stragglers if they prevent the window from closing.

### Hard fallback

If at any point the binding's continued presence is causing operational pain
(e.g. a Wrangler bug, a Cloudflare side effect, or a security advisory on the
legacy code path), the fallback is to terminate all remaining instances
(`wrangler workflows instances terminate <id>` for each, scriptable from the
`instances list` JSON output) and proceed directly to §3 step 3. The cost is
that any in-flight legacy package workflow loses its remaining work and is
reported as `terminated` rather than `complete` / `errored`.
