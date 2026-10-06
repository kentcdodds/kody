---
name: ship-pr
description: >
  Babysit a PR to done with the @kentcdodds/ship-pr Kody package: tick the PR,
  read the focused step, fix / reply / decide, and tick again until done (merge
  or park, deploy, leftover friction, Discord summary). Use when a pull request
  needs to be shepherded to done.
---

# Ship PR

The process lives in the Kody package `@kentcdodds/ship-pr` (runbook: its
`AGENTS.md`, via `search({ entity: "package:@kentcdodds/ship-pr" })`). This
skill only says how to drive it. Change behavior in the package, not here.

## Risk

Self-assess `risk` and pass it on every tick; user policy overrides. Kent's
standing policy (2026-08-08): auto-ship once AI feedback is handled and CI is
green, unless high risk.

- **low:** green CI; AI review optional; bot nits ignorable.
- **medium:** wait for Bugbot; handle valid feedback.
- **high:** also wait for CodeRabbit / Devin; park ready-for-review unless the
  user granted merge authority (pass `mergeAuthority: true`).

## Loop

Run exports with the local CLI. Bootstrap, login, token priority, saved-package
imports, and the hosted MCP `execute` ban live in
[prefer-local-cli-execute](../prefer-local-cli-execute/SKILL.md). The CLI
rejects `--local` with `--invoke`, so use the static-import passthrough that
tick's `exampleInvokes` already print:

```bash
npx @kodycodes/cli execute --local \
  --code 'import run from "kody:@kentcdodds/ship-pr/tick"; export default (p) => run(p)' \
  --params '{"prUrl":"https://github.com/kentcdodds/kody/pull/123","risk":"medium","applySafeAutomations":true}'
```

1. **Tick.** First tick is full (`checklist` + focus details). Re-tick
   `exampleInvokes` pass `brief: true` (compact: no checklist/prose). Pass
   `applySafeAutomations` to mark ready, trigger Bugbot as kentcdodds
   (medium/high, once per head SHA), and reply "invalid" on sorted invalid bot
   findings.
2. **Read** `checklist` (full ticks only), `done`, `remaining`, and
   `exit.reportStatus` (`Pending` until `Shipped` / `Parked` / `Blocked`). Only
   the focus step carries `details`; `exampleInvokes` are ready-to-run commands.
3. **Decide.** You own the call on CI and AI feedback: fix + push and reply
   `Fixed in <sha>: …` (`./reply-review`), reply with wontfix reasoning, or
   record a 7-day `./decide` (`ignored | skipped | wontfix | accepted`, reason
   required) for noise (a thread, a check, an AI reviewer you will not wait on,
   or a step where `merge` skipped means park).
4. **Wait** when `exit.status` is `waiting`: about `pollAfterSeconds`, or end
   the turn. Do not tight-loop or code-thrash.
5. **Tick again** (prefer the printed re-tick with `brief: true`) until
   `exit.done`.

When tick focuses `merge`, use `./merge` (squash, preflighted, pinned to the
head SHA). When it focuses `friction`, file leftovers per
[file-friction](../file-friction/SKILL.md) /
`kody:@kentcdodds/friction-log/file`, then decide step `friction`. When it
focuses `report`, pass the Discord fields to `./send-summary` (`status` defaults
from the PR: merged → Shipped, else Parked):

- `title`: human headline of the change (not `ship owner/repo#N`).
- `difficulty`: `Easy | Medium | Hard` (not risk).
- `agentId`:
  `curl -fsS --unix-socket "${CURSOR_AGENT_SOCKET:-/run/cursor/api.sock}" http://cursor-agent/v1/meta-data/agent/id`,
  or the `bc-` id from your launch URL.
- `model`: `…/v1/meta-data/turn/model` on the same socket, or the launch
  `model.id`. Missing means omit. Never infer.
- `extras`: links to user-visible pages that actually deployed. Never invent
  URLs.

## This repo

- Medium+: `npm run control-kody -- preview` (or `npm run preview:manual-test`)
  as the seeded user with data for this change
  ([control-kody](../control-kody/SKILL.md),
  [preview-manual-test](../preview-manual-test/SKILL.md)). Admin-gated states:
  local admin plus Workers or unit tests are sufficient evidence.
- Gates ≠ CI: blocked on soak / parity / calendar gate → end the run and
  schedule a wake (`workflows.create({ runAt, idempotencyKey })`). Leftovers get
  a `Cleanup:` issue
  ([cleanup-after-migrations](../cleanup-after-migrations/SKILL.md)).
- PR bodies say `Related to #N`, never `does not close #N`.
- Non-trivial PR descriptions include a system recap. Author that block with
  [visual-recap](../visual-recap/SKILL.md).
