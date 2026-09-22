# Onboarding process

The signed-in `/onboarding` wizard, the derived setup checklist, and the
optional first-win email guide share one contract:

[`packages/worker/universal/onboarding-process.ts`](../../../packages/worker/universal/onboarding-process.ts)

| Surface                                  | Role                                                                                      |
| ---------------------------------------- | ----------------------------------------------------------------------------------------- |
| Wizard index `/onboarding`               | Redirects to the first unfinished step (Step 3 once Step 2 is done)                       |
| Wizard Step 1 `/onboarding/step-1`       | Connect an MCP host                                                                       |
| Wizard Step 2 `/onboarding/step-2`       | Make something useful (one prompt + first `search` + `guide:onboarding` first-win picker) |
| Wizard Step 3 `/onboarding/step-3`       | Connect a second ecosystem (known hosts disabled; `guide:portability`)                    |
| Checklist                                | Verify email, complete the three wizard steps, then persist a package                     |
| [`first-win`](../../guides/first-win.md) | Optional email → reply → memories loop after a host is connected                          |

Step 2 is one copy-paste prompt that tells the connected agent to retrieve
[`onboarding`](../../guides/onboarding.md)
(`search({ entity: "guide:onboarding" })`). The guide presents six concrete
first-win choices (PR readiness, an always-on ping, skill→owned package, email
wake when the host can be woken, Slack/Raycast webhook, or something else) and
the agent does one small win from their pick. The page shows a spinner until
Kody observes that first successful `search` (or an existing access win: memory,
execute, or saved package). Leftover `/onboarding/step-2/:service` URLs redirect
to Step 2. Leftover `/onboarding/step-3/not-listed` URLs return to the Step 3
ecosystem picker. Hosted / platform OAuth is not the onboarding path; new
connects are bring-your-own.

Step 3 groups the agent picker by ecosystem (Grok, Claude, ChatGPT, and the
rest). Cursor Local and Cursor Cloud are separate tabs when the grant redirect
shows which surface authorized. An unclassified Cursor grant (client name
Cursor, no surface on the grant redirect) counts as the Grok ecosystem and
disables neither Local nor Cloud. A Cursor Cloud grant also marks Grok Bot
connected. Cursor Local, Cursor Cloud, Grok Bot, Grok.com, and Grok CLI sit in
that Grok ecosystem. Tabs disable only for hosts a grant already names. After
the person picks a host, a short portability-proof prompt is folded into the
same step so the new agent looks up [`portability`](../../guides/portability.md)
(`search({ entity: "guide:portability" })`) and reuses what Step 2 made. When
the onboarding payload has a known memory subject or saved-package name, Step 3
shows a short "You made …" chip (truncated subject and `@scope/kody-id`, or
hidden if nothing sensible). `hasSecondMcpClient` is two known ecosystems, not
raw grant count, not unique `clientId`s, and not attribution to the selected
host — Cursor hosts and Grok hosts are one ecosystem, and an unlabeled client
does not count as its own. The connected label stays "You've connected a second
agent." When the second-agent Standard gift is active, that status adds
"Standard is free for 2 weeks." Step 3 copy advertises "Connect a second agent
and get Standard free for 2 weeks." `/onboarding` resumes at that step instead
of always opening the Step 1 picker. The Step 1 and Step 3 pickers, and Step 2,
list already-connected hosts so a return visit cannot hide Cursor or Claude
Desktop. A selected-agent card names only that host: another client's connection
does not mark this one connected and does not put its logo on the card. A
remembered picker choice is not a grant. When a different host actually
authorized, Step 2 and Step 3 follow that grant instead of the pick. Account →
Connections (`/account/connections`) lists those inbound hosts grouped by
display name, with public logos for known kinds, newest-first sort, best-effort
labels, and per-`clientId` revoke. That list is not `users.mcp_client_name`
(first-touch) and not `/account/mcp-oauth-clients` (user-minted confidential
clients).

`first-win` is not a wizard step and is not a checklist item. Signed-in
`/onboarding` does not probe Mailbox for that loop. MCP registers
`onboarding_first_win` and `search({ entity: "guide:first_win" })` serves the
guide.

Waiting (`/account/waiting` and `waitingSummary`) is a separate current-state
queue. Wizard-resume and first-use cards live there. See
[Waiting](../../use/waiting.md).

## Alignment check

`packages/worker/universal/onboarding-process.node.test.ts` (part of
`npm run test:node` / `npm run validate`) requires `docs/guides/first-win.md` to
name each current wizard step (label or path). `docs/guides/quick-example.md`
names Step 2's label and the Step 1 path. The first-run briefing is
`docs/guides/onboarding.md` and must name the six first-win choices.

Change the wizard in `onboarding-process.ts` first, then update those two guides
until the test passes. The same check requires `docs/guides/portability.md` to
name Step 3 and stay short. The checklist union has no first-win items; adding
them fails the same check.
