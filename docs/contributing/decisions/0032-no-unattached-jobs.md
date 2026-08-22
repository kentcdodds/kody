# 0032: No unattached jobs

- **Status:** accepted
- **Date:** 2026-08-21

## Context

Jobs and workflows overlapped as authoring units. `job_schedule` /
`job_schedule_once` created repo-backed schedules that were not a package
(`entity_kind: 'job'`). Workflows already cover deferred one-shots
(`workflows.create({ runAt })`). Packages already own recurring schedules
(`kody.jobs`). Agents were told "scheduling alone is not a reason to package."

Production `kody-jobs` on 2026-08-21: 118 rows, 84 unattached, 17 live
unattached across 7 accounts. Community listings and saved-package search text
did not call `job_schedule`. Recurring unattached jobs cannot become workflow
chains without inventing workflow cron (a thinner twin).

## Decision

Do not author schedules outside a package. Recurring and interval work is a
package job. Deferred or long-running one-shot work is a workflow started from
`execute` or package runtime. Do not add workflow cron, a `schedule()` wrapper
package, or an unattached-job capability.

`job_list`, `job_get`, `job_run_now`, metadata `job_update`, and `job_delete`
remain for package jobs and for any leftover unattached rows until those rows
are gone. The runner does not care how a row was created.

## Consequences

MCP, `/account/jobs`, usage docs, and discovery evals describe package jobs and
workflows only. `/account/workflows` is a view over existing
`workflow_projections`, not a new primitive. Revisit only if a recurring
schedule must exist without a package _and_ without a workflow — that has not
shown up in the fleet.
