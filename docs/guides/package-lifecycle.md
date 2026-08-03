# Durable package lifecycle

Use this guide to decide whether to reuse existing behavior, explore with
`execute`, or create durable repo-backed package code. Use it before scheduling
new package behavior.

## Choose the smallest durable surface

### Invoke an existing package or capability

Search first. If a built-in capability or saved package already does the work,
invoke it instead of creating another implementation.

- Call discovered built-in capabilities through `kody` in `execute`.
- For a saved package export whose package name is known when the code is
  written, use a static `kody:@scope/package/export` import — the default for
  package reuse from `execute` and from other packages. Ad hoc execute bundles
  per call, so static imports from execute always see the current published
  version.
- Use keyless `packages.invoke({ kodyId, exportName, params })` from an
  authenticated `execute` call or package runtime when the target's name is data
  or the call must run in the target package's own runtime (package secret
  mounts, `packageStorage()`, `packageContext`). Pass `idempotencyKey` only when
  the call needs exactly-once semantics.

This is the default for an established operation whose behavior should stay
owned by its existing capability or package.

### Use `execute` for temporary one-off exploration

Use `execute` when the code is disposable: inspect an API response, test an
assumption, transform a small result, or run a one-time operation after any
required confirmation.

Keep the module focused and return structured evidence. Do not treat the
ephemeral module as the durable source for behavior that must be maintained,
reused, or evolved.

### Fork a close community package before creating

Community listings are excluded from general `search`. When you need durable
reusable behavior and nothing in the user's account fits, call
`community_search` and prefer **trusted** matches.

If a listing is close to the user's goal:

1. Inspect it with `community_get`.
2. Fork with `community_fork` (or point the user at one-click install on
   `/onboarding` or the listing detail page).
3. Review the forked source, adapt it to the user's intent (including the README
   `## Intent` section), then publish.

Do not reimplement from scratch when a trusted community package is already
close. Create a new package only when no suitable listing exists.

### Create a repo-backed package

Create or extend a saved package when behavior is reusable, expected to evolve,
or needs a named package-owned schedule that evolves with its implementation,
and no suitable community listing (or existing saved package) covers it. The
repo rooted at `package.json` is the durable source of truth. Package exports
form the callable surface, while jobs, subscriptions, services, retrievers, and
apps remain package-owned behavior.

Scheduling alone does not require a package. Use `job_schedule` directly for a
genuinely ad hoc or one-off job, or for a simple self-contained schedule that is
not tied to reusable package behavior. `job_schedule_once` is the one-off
convenience form. Optional `expires_at` (UTC ISO) stops scheduling and
auto-disables the job after that time without requiring the job to self-disable.

Use `guide: "package_authoring"` for package shape, README `## Intent`,
visibility guidance, and the secret-using package approval checklist
(`pending_secret_package_approvals` is non-null only for unadopted
community-forked packages; prefer `community_fork_adopt` after review, or bulk
approval URLs when present).

## Signals to escalate from `execute` to a package

Move the behavior into a package when one or more of these become true:

- the user will run it again or other package code should reuse it
- it needs a named package-owned schedule that should evolve with the
  implementation, or another durable surface such as a subscription, service,
  app, workflow entrypoint, or package-owned storage
- the logic needs tests, multiple files, dependencies, review, or version
  history
- inputs, output, error handling, or integration behavior will evolve
- a one-off script has already been copied, repaired, or rerun
- you are calling a third-party **product** API with raw integration auth
  helpers (`createAuthenticatedFetch`, `refreshAccessToken`, or equivalent)
  beyond a cheap smoke test — **integrations = auth; packages = how agents
  should call the product**. Search for an existing wrapper package first, then
  `community_search` (prefer **trusted**), then fork or create a thin helpers
  package

Do not create a package merely to wrap one clear call to an existing capability
or package export, or merely because a simple self-contained job needs a
schedule.

## Choose an authoring lane

### Git lane for coding agents

When a normal filesystem and git client are available:

1. Call `package_get_git_remote`. For a new package, pass `create: true` and a
   new `kody_id`; for an existing package, omit `create`.
2. Run the returned setup commands and clone into a temporary directory.
3. Edit and test through the normal local development loop.
4. Commit and push the package repository.
5. Publish the pushed head with `package_publish_external_push`.

This lane supports binary assets, multi-file changes, local tests, and normal
git review.

### Tool-only lane

Without local filesystem or git access:

1. Create the complete UTF-8 text package with `package_save`, or inspect an
   existing package with `package_get`.
2. Use `repo_open_session`, `repo_edit_files` (or `repo_write_file`),
   `repo_commit`, and `repo_run_checks` for repo-backed edits and validation.
3. Publish with `repo_publish_session`.

If the work needs binary assets, broad refactors, or a substantial local
build/test loop, explain that it fits a coding-capable agent and confirm before
continuing in the tool-only lane.

## Test the scheduled wrapper before enabling its schedule

Scheduled behavior should not be its first real execution. Package job manifests
do not supply params to their entrypoints, so structure the package with:

- a shared implementation that accepts explicit input
- an optional callable export that passes representative input to that
  implementation
- a no-argument scheduled wrapper that loads its own current configuration and
  calls the same implementation

Make the no-argument scheduled wrapper callable through `package.json.exports`,
point the package job entry at that wrapper, and initially declare the
package-owned job with `"enabled": false`.

After package checks and publishing succeed:

1. Inspect the published package and export contracts.
2. Invoke the scheduled wrapper from authenticated `execute` with keyless
   `packages.invoke(...)` and omit `params`. This verifies the same no-input
   contract the scheduler uses, in the package's own runtime.
3. Optionally invoke the underlying callable export with representative input:
   realistic field shapes, boundary values, and the same configuration
   references the wrapper will load. Never put plaintext secrets in params.
4. Validate the structured results and the intended durable or external effects.
   Exercise an expected failure path when the operation is risky.
5. Only then change the job to `"enabled": true`, publish again, and verify the
   package/job detail reflects the enabled schedule.

Example test call:

```ts
import { packages } from 'kody:runtime'

export default async function main() {
	return await packages.invoke({
		kodyId: 'daily-report',
		exportName: './scheduled-report',
	})
}
```

For exports that send messages, write remote records, charge accounts, or make
other external mutations, prefer a package-specific `dryRun` input. Implement it
so the export performs validation and returns a preview while skipping the
mutation. `dryRun` is a package contract, not an automatic Kody runtime flag;
test the dry-run path first.

Immediately before any live external mutation, obtain explicit user confirmation
that identifies the target and scope of the mutation. Do not infer confirmation
from an earlier request, a successful dry run, or the agent's own assessment.
After confirmation, perform only the confirmed call, then report the result.
Require fresh confirmation if the target or scope changes.

Keep the schedule disabled when representative testing is inconclusive,
credentials or host approval are missing, the result is unexpected, or the live
mutation has not been explicitly confirmed by the user.

## Evolve the durable behavior

For later changes, inspect the current repo, preserve the package's intent,
update tests and docs with the implementation, and repeat the disabled
schedule/export test when the scheduled path or its inputs change. Publish only
checked commits; do not patch generated runtime state as a substitute for
changing the package source.
