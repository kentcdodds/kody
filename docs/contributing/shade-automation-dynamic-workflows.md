# Shade automation Dynamic Workflows pilot

This note scopes the first Kody Dynamic Workflows pilot around the live
`shade-automation` saved package. It is a design and rollout note, not a claim
that Cloudflare Workflows are already wired into Kody.

## Current package shape

Live package metadata from Kody MCP:

- Package: `@kentcdodds/shade-automation`
- Kody id: `shade-automation`
- Package id: `1a0476b4-c1d6-47ad-802e-dd5f4631c919`
- Exports:
  - `./plan-day`
  - `./run-event`
  - `./tick`
  - `./cloud-watch`
  - `./event-runner`
  - `./estimate-day`
- Package jobs:
  - `daily-plan`: cron `0 3 * * *`, `America/Denver`
  - `event-runner`: interval `1m`, `America/Denver`
  - `cloud-watch`: interval `10m`, `America/Denver`

The current daily flow is:

1. `daily-plan` calls `plan-day` and persists `shadeAutomationPlan`.
2. `event-runner` wakes every minute, reads the plan, finds due events, runs
   `run-event`, and records executed event keys in job storage.
3. `cloud-watch` wakes every ten minutes to reconcile cloud-sensitive windows.

This is intentionally package-first and works with today's Kody job runtime, but
the one-minute polling job is the clearest place where Workflows can provide a
better execution model.

## Why this package is the pilot

Shade automation has real workflow semantics:

- a daily plan produces a bounded list of future event times
- each event has a durable target time
- each event must run at most once for a given plan date and key
- event execution needs retry when the home connector or shade device fails
- stale events should be skipped rather than replayed hours later

Those semantics map better to durable workflow instances than to frequent
polling.

## Target workflow model

Keep `shade-automation` as a saved package. Do not create a new top-level Kody
primitive.

The pilot should add package-runtime infrastructure that can start a workflow
instance for package-owned work:

1. `daily-plan` remains a normal package job.
2. After it persists the plan, Kody starts one workflow instance per planned
   event.
3. Each workflow instance:
   - stores routing metadata: package id, source id, user id, export name, plan
     date, event key
   - sleeps until the event `runAt`
   - runs `kody:@kentcdodds/shade-automation/run-event` through the existing
     package execution path
   - persists success/failure detail in the same durable storage model used by
     package jobs
   - retries transient failures with Workflow step retry semantics
4. `event-runner` stays enabled as a fallback during the pilot, then becomes
   removable after the workflow path covers a full day.

Use workflow metadata only for routing identifiers. Do not place device tokens,
secret values, shade configuration JSON, or full event action payloads in
workflow metadata because Cloudflare persists workflow event data.

## Runtime support needed

Kody does not currently declare a Cloudflare Workflows binding. The first
runtime change should be small and package-oriented:

- add a Worker `WorkflowEntrypoint` for package event runs
- add a Workflows binding in `packages/worker/wrangler.jsonc`
- add an internal helper that creates deterministic workflow ids for package
  event work
- make the workflow entrypoint delegate to the existing package bundle executor
  rather than introducing a second package execution stack
- expose the helper only through package/job runtime internals at first, not as
  a public MCP capability

This keeps the public Kody MCP surface compact while proving whether Workflows
are useful package infrastructure.

## Suggested workflow id

Use deterministic ids so a repeated daily planner does not duplicate work:

```text
package-event:<package-id>:<workflow-name>:<date>:<event-key>
```

For the shade pilot:

```text
package-event:1a0476b4-c1d6-47ad-802e-dd5f4631c919:shade-event:<yyyy-mm-dd>:<event-key>
```

## Rollout plan

1. Add the core workflow binding and entrypoint behind internal helpers.
2. Add a package-runtime helper that starts event workflows for a package
   export.
3. Update `shade-automation` so `daily-plan` requests event workflow creation
   after `plan-day` persists a plan.
4. Keep `event-runner` enabled for the first pilot day as a safety net.
5. Compare workflow execution records with `event-runner` storage records.
6. Disable `event-runner` only after the workflow path executes a full day of
   shade events without duplicate sends.

## Non-goals for the first pass

- general user-authored workflow manifests
- a new top-level saved `workflow` entity
- public MCP workflow creation tools
- converting `cloud-watch` to Workflows
- using Workflows to hold long-lived home connector state

## Validation

The pilot is only ready to use when these checks pass:

- package checks pass for `shade-automation`
- the daily planner creates deterministic workflow ids for every planned event
- re-running the planner does not create duplicate event executions
- at least one dry-run workflow reaches the package `run-event` export
- at least one live event executes through the workflow path
- `event-runner` does not duplicate a workflow-executed event
- failure of one event workflow does not block later planned events
