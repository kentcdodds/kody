---
name: ship-pr
description: >
  Babysit a PR to done with the @kentcdodds/ship-pr Kody package: tick the PR,
  read the focused step, fix / reply / decide, and tick again until done (merge
  or park, deploy, leftover friction, Discord summary). Use when a pull request
  needs to be shepherded to done.
---

# Ship PR

When a pull request needs to be shepherded to done. The loop is the Kody package
`@kentcdodds/ship-pr` (`search({ entity: "package:@kentcdodds/ship-pr" })`).
Change behavior in the package, not here.

Pass `risk` on every tick. User policy overrides.

- **low:** green CI. AI review is optional.
- **medium:** wait for Bugbot. Handle valid feedback.
- **high:** also wait for CodeRabbit and Devin. Park unless `mergeAuthority` is
  true.

Credential setup is
[prefer-local-cli-execute](../prefer-local-cli-execute/SKILL.md).

## Command

The CLI rejects `--local` together with `--invoke`. Use the static import tick
prints in `exampleInvokes`. The first tick is full. Re-ticks pass `brief: true`.

```bash
npx @kodycodes/cli execute --local \
  --code 'import run from "kody:@kentcdodds/ship-pr/tick"; export default (p) => run(p)' \
  --params '{"prUrl":"https://github.com/kentcdodds/kody/pull/123","risk":"medium","applySafeAutomations":true}'
```

## Failure

- `exit.status` is `waiting`. Wait about `pollAfterSeconds`, or end the turn. Do
  not tight-loop.
- A check or bot finding you will not fix: `./decide` with a reason (`ignored`,
  `skipped`, `wontfix`, or `accepted`).
- A valid finding: fix, push, and `./reply-review` with `Fixed in <sha>: ...`.
- Focus `merge`: `./merge`. Focus `friction`:
  [file-friction](../file-friction/SKILL.md). Focus `report`: the printed
  `./send-summary`. Take `agentId` and `model` from the agent socket. Omit
  `model` when the socket has none. Do not invent URLs.
- This repo, medium or high: preview with
  [control-kody](../control-kody/SKILL.md). PR bodies say `Related to #N`, never
  `does not close #N`. Non-trivial descriptions include a system recap
  ([visual-recap](../visual-recap/SKILL.md)).
