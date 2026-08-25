# Onboarding process

The signed-in `/onboarding` wizard, the derived setup checklist, and the
optional first-win email guide share one contract:

[`packages/worker/universal/onboarding-process.ts`](../../../packages/worker/universal/onboarding-process.ts)

| Surface                                  | Role                                                             |
| ---------------------------------------- | ---------------------------------------------------------------- |
| Wizard Step 1 `#connect-agent`           | Connect an MCP host                                              |
| Wizard Step 2 `#connect-mcp`             | Give Kody Access (featured/custom MCP, Just-try-Kody, or skip)   |
| Wizard Step 3 `#first-build`             | Persist the first owned package (`/guides/quick-example`)        |
| Checklist                                | Verify email plus those three wizard steps                       |
| [`first-win`](../../guides/first-win.md) | Optional email → reply → memories loop after a host is connected |

`first-win` is not a wizard step and is not a checklist item. Signed-in
`/onboarding` does not probe Mailbox for that loop. MCP still registers
`onboarding_first_win` and `coding_guide_get` still serves the guide.

## Alignment check

`packages/worker/universal/onboarding-process.node.test.ts` (part of
`npm run test:node` / `npm run validate`) requires `docs/guides/first-win.md` to
name each current wizard step (label or `#hash`), to link
`/guides/quick-example`, and to send Step 6 to `/onboarding#first-build`. It
also requires `docs/guides/quick-example.md` to name Step 3's label and the Step
2 hash.

Change the wizard in `onboarding-process.ts` first, then update those two guides
until the test passes. The checklist union has no first-win items; adding them
fails the same check.
