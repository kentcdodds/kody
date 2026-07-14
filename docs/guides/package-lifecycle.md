# Durable package lifecycle

Use this guide to decide whether to reuse existing behavior, explore with
`execute`, or create durable repo-backed package code. Use it before scheduling
new package behavior.

## Choose the smallest durable surface

### Invoke an existing package or capability

Search first. If a builtin capability or saved package already does the work,
invoke it instead of creating another implementation.

- Call discovered builtin capabilities through `kody` in `execute`.
- For a saved package's current published export, use
  `packages.invokeChecked({ kodyId, exportName, params })` from an authenticated
  `execute` call or package runtime.
- Use a static `kody:@scope/package/export` import only when a bundled,
  published snapshot is the intended dependency behavior.

This is the default for an established operation whose behavior should stay
owned by its existing capability or package.

### Use `execute` for temporary one-off exploration

Use `execute` when the code is disposable: inspect an API response, test an
assumption, transform a small result, or run a one-time operation after any
required confirmation.

Keep the module focused and return structured evidence. Do not treat the
ephemeral module as the durable source for behavior that must be maintained,
reused, or scheduled.

### Create a repo-backed package

Create or extend a saved package when behavior is reusable, scheduled, or
expected to evolve. The repo rooted at `package.json` is the durable source of
truth. Package exports form the callable surface, while jobs, subscriptions,
services, retrievers, and apps remain package-owned behavior.

Use `guide: "package_authoring"` for package shape, README `## Intent`, and
visibility guidance.

## Signals to escalate from `execute` to a package

Move the behavior into a package when one or more of these become true:

- the user will run it again or other package code should reuse it
- it needs a schedule, subscription, service, app, workflow entrypoint, or
  package-owned storage
- the logic needs tests, multiple files, dependencies, review, or version
  history
- inputs, output, error handling, or integration behavior will evolve
- a one-off script has already been copied, repaired, or rerun

Do not create a package merely to wrap one clear call to an existing capability
or package export.

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
2. Use `repo_open_session`, `repo_write_file`, and `repo_run_commands` for
   repo-backed edits and checks.
3. Publish with `repo_publish_session`.

If the work needs binary assets, broad refactors, or a substantial local
build/test loop, explain that it fits a coding-capable agent and confirm before
continuing in the tool-only lane.

## Test an export before enabling its schedule

Scheduled behavior should not be its first real execution. Make the package job
entry callable through `package.json.exports`, and initially declare the
package-owned job with `"enabled": false`.

After package checks and publishing succeed:

1. Inspect the published package and export contract.
2. Invoke the export from authenticated `execute` with
   `packages.invokeChecked(...)`.
3. Pass representative input: realistic field shapes, boundary values, and the
   same configuration references the schedule will use. Never put plaintext
   secrets in params.
4. Validate the structured result and the intended durable or external effects.
   Exercise an expected failure path when the operation is risky.
5. Only then change the job to `"enabled": true`, publish again, and verify the
   package/job detail reflects the enabled schedule.

Example test call:

```ts
import { packages } from 'kody:runtime'

export default async function main() {
	return await packages.invokeChecked({
		kodyId: 'daily-report',
		exportName: './run-report',
		params: {
			reportDate: '2026-07-14',
			dryRun: true,
		},
	})
}
```

For exports that send messages, write remote records, charge accounts, or make
other external mutations, prefer a package-specific `dryRun` input. Implement it
so the export performs validation and returns a preview while skipping the
mutation. `dryRun` is a package contract, not an automatic Kody runtime flag;
test both the dry-run path and one deliberately confirmed live invocation before
enabling recurring execution.

Keep the schedule disabled when representative testing is inconclusive,
credentials or host approval are missing, the result is unexpected, or the live
mutation has not been confirmed.

## Evolve the durable behavior

For later changes, inspect the current repo, preserve the package's intent,
update tests and docs with the implementation, and repeat the disabled
schedule/export test when the scheduled path or its inputs change. Publish only
checked commits; do not patch generated runtime state as a substitute for
changing the package source.
