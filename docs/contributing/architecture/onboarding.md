# Onboarding process

The signed-in `/onboarding` wizard, the derived setup checklist, and the
optional first-win email guide share one contract:

[`packages/worker/universal/onboarding-process.ts`](../../../packages/worker/universal/onboarding-process.ts)

| Surface                                  | Role                                                                    |
| ---------------------------------------- | ----------------------------------------------------------------------- |
| Wizard Step 1 `/onboarding/step-1`       | Connect an MCP host                                                     |
| Wizard Step 2 `/onboarding/step-2`       | Give Kody Access (MCP chips + Show more; prompt on `:service`)          |
| Checklist                                | Verify email, the two wizard steps, then persist on `/account/packages` |
| [`first-win`](../../guides/first-win.md) | Optional email → reply → memories loop after a host is connected        |

Step 2's index is the official MCP chip grid plus Show more. A selected service
(`/onboarding/step-2/:service`) shows the copyable prompt and milestones. Hosted
/ platform OAuth is not the onboarding path; new connects are bring-your-own.

`first-win` is not a wizard step and is not a checklist item. Signed-in
`/onboarding` does not probe Mailbox for that loop. MCP still registers
`onboarding_first_win` and `search({ entity: "first_win:guide" })` still serves
the guide.

## Alignment check

`packages/worker/universal/onboarding-process.node.test.ts` (part of
`npm run test:node` / `npm run validate`) requires `docs/guides/first-win.md` to
name each current wizard step (label or path), to link `/guides/quick-example`,
and to send Step 6 to `/onboarding/step-2`. It also requires
`docs/guides/quick-example.md` to name Step 2's label and the Step 1 path.

Change the wizard in `onboarding-process.ts` first, then update those two guides
until the test passes. The checklist union has no first-win items; adding them
fails the same check.
