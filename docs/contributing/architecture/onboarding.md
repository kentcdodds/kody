# Onboarding process

The signed-in `/onboarding` wizard, the derived setup checklist, and the
optional first-win email guide share one contract:

[`packages/worker/universal/onboarding-process.ts`](../../../packages/worker/universal/onboarding-process.ts)

| Surface                                  | Role                                                                     |
| ---------------------------------------- | ------------------------------------------------------------------------ |
| Wizard Step 1 `/onboarding/step-1`       | Connect an MCP host                                                      |
| Wizard Step 2 `/onboarding/step-2`       | Make something useful (one prompt + first `search` + `onboarding:guide`) |
| Wizard Step 3 `/onboarding/step-3`       | Connect a second agent (same-ecosystem hosts greyed)                     |
| Checklist                                | Verify email, complete the three wizard steps, then persist a package    |
| [`first-win`](../../guides/first-win.md) | Optional email → reply → memories loop after a host is connected         |

Step 2 is one copy-paste prompt that tells the connected agent to retrieve
[`onboarding`](../../guides/onboarding.md)
(`search({ entity: "onboarding:guide" })`). The page shows a spinner until Kody
observes that first successful `search` (or an existing access win: memory,
execute, or saved package). Leftover `/onboarding/step-2/:service` URLs redirect
to Step 2. Hosted / platform OAuth is not the onboarding path; new connects are
bring-your-own.

Step 3 reuses the Step 1 agent picker. Hosts in the same vendor family as the
first agent are greyed so the second connect is a different ecosystem. After the
person picks a host, a short portability-proof prompt is folded into the same
step so the new agent reuses what Step 2 made.

`first-win` is not a wizard step and is not a checklist item. Signed-in
`/onboarding` does not probe Mailbox for that loop. MCP registers
`onboarding_first_win` and `search({ entity: "first_win:guide" })` serves the
guide.

## Alignment check

`packages/worker/universal/onboarding-process.node.test.ts` (part of
`npm run test:node` / `npm run validate`) requires `docs/guides/first-win.md` to
name each current wizard step (label or path). `docs/guides/quick-example.md`
names Step 2's label and the Step 1 path. The first-run briefing is
`docs/guides/onboarding.md`.

Change the wizard in `onboarding-process.ts` first, then update those two guides
until the test passes. The checklist union has no first-win items; adding them
fails the same check.
