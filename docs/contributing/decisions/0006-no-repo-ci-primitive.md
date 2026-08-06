# 0006: No repo/package CI primitive for now

- **Status:** accepted
- **Date:** 2026-08-05

## Context

Cloudflare shipped `@cloudflare/ci` (Workflows + Sandbox based CI triggered by
`cf.artifacts.repo.pushed` events), which would let Kody run a repo's own test
suite in a sandboxed shell — something no current runtime supports. The platform
already gates publishes with `runRepoChecks`
(manifest/dependencies/bundle/typecheck/lint in
`packages/worker/src/repo/checks.ts`), and the Artifacts push queue
(`packages/worker/src/repo/artifacts-event-queue.ts`) already consumes push
events for subscription fan-out, so the trigger, result surface (run records),
and publish hook (`publishFromExternalRef`) all exist.

The question: should repos and packages get an opt-in CI primitive, enabled by a
config file in the repo?

## Decision

Not now. The main authoring lane — coding agents with a local clone — already
runs tests locally before `package_publish_external_push`, so CI would re-run
what already ran; in single-user personal software the pusher and the
beneficiary are the same person's agent, so the multi-contributor trust problem
CI solves does not exist. Tool-only authoring lanes (`package_save`, repo
sessions) cannot run tests, but `runRepoChecks` already covers the worst failure
modes there. Per-push sandbox time is the first per-run compute cost of this
size, and the value does not justify it today.

## Consequences

- Publish checks (`runRepoChecks`) remain the only platform gate; agents remain
  responsible for running a repo's own tests before pushing.
- Deferring creates no architectural regret: the push-queue consumer, config
  file, and a new run-record surface can all be added later without reworking
  anything that exists.
- The preferred future shape, if revisited: opt-in via a config file in the repo
  (presence enables CI; something like `.kody/ci.json`); declarative named steps
  interpreted by a platform-owned CI Workflow built on `@cloudflare/ci` — users
  never author Workflow code; per-repo choice of advisory runs or auto-publish
  on green expressed as a declarative terminal step calling the same
  `publishFromExternalRef` path (platform checks and `base_moved` protections
  still apply); secrets mounted like `secretMounts` with mounted secret values
  scrubbed from captured output before run-record logs persist; `recordUsage()`
  metering and an entitlement cap on sandbox time from the first version.
- Revisit if the tool-only authoring lane grows a real need for test execution,
  or if push-to-auto-publish becomes a requested workflow.
