# Claude Connectors Directory

Operator checklist for listing Kody as a remote MCP connector at
`https://kody.codes/mcp`. This is not a product surface and does not change the
compact `search` / `execute` contract. Do not submit from this document —
submission happens in a Claude Team or Enterprise org portal.

Official Anthropic pages:

- [Submitting to the Connectors Directory](https://claude.com/docs/connectors/building/submission)
- [Pre-submission checklist](https://claude.com/docs/connectors/building/review-criteria)
- [Testing your connector](https://claude.com/docs/connectors/building/testing)
- [Authentication](https://claude.com/docs/connectors/building/authentication)

## Ready vs blocked

| Item                                                  | Status                                                                          |
| ----------------------------------------------------- | ------------------------------------------------------------------------------- |
| HTTPS Streamable HTTP at `https://kody.codes/mcp`     | Ready (`server.json` remotes)                                                   |
| OAuth 2.0 with DCR and CIMD                           | Ready (`/auth.md`, PKCE S256)                                                   |
| Tool `title` plus `readOnlyHint` or `destructiveHint` | Ready; enforced by `mcp-tool-descriptions.node.test.ts`                         |
| Tool names ≤ 64 characters                            | Ready (`search`, `execute`)                                                     |
| Separate read vs write MCP tools                      | Ready at the MCP layer (`search` read-only, `execute` destructive)              |
| Privacy policy HTTPS URL                              | Ready: `https://kody.codes/privacy`                                             |
| Public docs HTTPS URL                                 | Ready: `https://kody.codes/docs`                                                |
| Icon                                                  | Ready: `https://kody.codes/images/kody-app-icon.png` (256×256 PNG, under 10 KB) |
| Domain matches first-party service                    | Ready (`kody.codes`)                                                            |
| `ui/open-link` allowed-link URIs                      | Not applicable (Kody does not call `ui/open-link`)                              |
| MCP App carousel screenshots                          | Not applicable (remote tools only, not an MCP App)                              |
| Claude Team / Enterprise org + Directory permission   | **Kent** — individual plans cannot open the portal                              |
| Portal submit                                         | **Kent** — do not submit from an agent                                          |
| Populated reviewer account + credentials              | **Kent** — do not invent secrets or mint production accounts                    |
| Kent runs every tool as a custom connector in Claude  | **Kent**                                                                        |

Custom-connector testing (any Claude plan) is separate from directory submit.
Add `https://kody.codes/mcp` under Customize → Connectors. That uses the same
runtime as a published listing.

## `execute` policy (the review risk)

Anthropic rejects a catch-all HTTP tool that accepts both safe methods (`GET`)
and unsafe methods (`POST` / `PUT` / `PATCH` / `DELETE`) — the example is
`api_request` with a `method` parameter. Documenting safe vs unsafe inside one
tool description does not satisfy that rule.

Kody's `execute` is not that shape. It has no HTTP `method` argument. It runs
one sandboxed ESM module in the signed-in user's isolated account. The module
can read or write depending on the code and capabilities it calls. Annotations
already declare `readOnlyHint: false` and `destructiveHint: true`, so Claude
should prompt on every execute.

### Options

1. **Keep `search` + `execute` and write a review narrative** (`Easy`). Matches
   [project intent](./project-intent.md) (Code Mode, compact MCP). Honest
   description and destructive annotation. Risk: a reviewer analogizes `execute`
   to `api_request` and rejects.
2. **Claude-only constrained tool list** (`Hard`). A second advertised surface
   (read tools plus narrow writes) for Claude, while other hosts keep `execute`.
   Contradicts compact-MCP intent, splits hosts, and still needs `execute` (or
   equivalent) for packages, jobs, and connected MCP.
3. **Split `execute` into read/write MCP tools** (`Hard`). Cannot be enforced:
   the argument is still arbitrary ESM. A "read" tool that accepts `code` is the
   same policy object with a friendlier name.

**Recommendation:** option 1. Submit the existing two-tool surface. If Anthropic
rejects on the catch-all rule, the fallback is option 2 — and only after that
rejection. Do not invent a second product surface before a human reviewer asks
for it.

**Review narrative to paste** (adapt, do not invent extra tools):

> Kody advertises two MCP tools. `search` is read-only capability and guide
> discovery. `execute` runs one sandboxed ESM module in the signed-in user's
> isolated account; it is annotated destructive because that module can send
> mail, persist packages, call user-authorized APIs, or delete account data.
> This is not an `api_request(method)` catch-all: there is no HTTP method
> parameter. Mutations go through Kody's first-party runtime and the user's own
> connected credentials. Claude should confirm every `execute` call.

## Listing assets

| Asset                          | URL / value                                                         |
| ------------------------------ | ------------------------------------------------------------------- |
| MCP URL                        | `https://kody.codes/mcp`                                            |
| Transport                      | Streamable HTTP (universal URL — every user uses the same URL)      |
| Docs                           | `https://kody.codes/docs` (connect: `/docs/connect-your-agent`)     |
| Privacy                        | `https://kody.codes/privacy` (markdown twin: `docs/use/privacy.md`) |
| Support                        | `support@kody.codes`                                                |
| Company site                   | `https://kody.codes`                                                |
| Icon                           | `https://kody.codes/images/kody-app-icon.png`                       |
| Favicon fallback               | `https://kody.codes/android-chrome-512x512.png`                     |
| Server card                    | `https://kody.codes/.well-known/mcp/server-card.json`               |
| OAuth callback (hosted Claude) | `https://claude.ai/api/mcp/auth_callback`                           |
| Suggested slug                 | `kody` (permanent after publish — confirm before submit)            |

Privacy already covers collection, use, storage, third-party sharing, retention,
and contact. Public connect docs already cover OAuth, verified email, and
per-host steps including Claude Desktop and Claude Code.

## Portal field copy

Paste these into the listing step. Counts are character counts including spaces.
Confirm categories against the portal picker — the published list is not in
Anthropic's public docs.

**Server name** (≤100): `Kody`

**Tagline** (≤55): `The home your agents share over MCP` (35)

Alternate tagline: `Isolated personal assistant via search and execute` (50)

**Description** (≤2000):

Kody is a per-user personal assistant you use from Claude — not a separate Kody
chat app. After OAuth, Claude gets two tools. search finds capabilities,
official guides, saved packages, integrations, and secret names (never secret
values). execute runs one sandboxed ESM module in your isolated account. That
module can read or write your Kody data and call services you connected (email,
GitHub, Google, and others). Approving access grants that Claude the same full
account access as any other host. Each Kody user is isolated. Free accounts can
connect and run execute within daily limits; paid plans raise those caps.

Create an account at https://kody.codes/signup, verify email, then connect
https://kody.codes/mcp. Docs: https://kody.codes/docs. Privacy:
https://kody.codes/privacy.

**Categories** (pick 1–5 in the portal): Productivity; Developer tools;
Communication. Confirm the exact labels in the picker.

**Documentation URL:** `https://kody.codes/docs`

**Privacy policy URL:** `https://kody.codes/privacy`

**Support contact:** `support@kody.codes`

**Icon:** upload `packages/worker/public/images/kody-app-icon.png` or point at
`https://kody.codes/images/kody-app-icon.png`

**Company name:** `Kent C. Dodds`

**Company website:** `https://kody.codes`

**Primary contact:** pre-filled from the submitting Claude account. Use
`support@kody.codes` if the portal asks for a review email.

### Connection

- Server URL: `https://kody.codes/mcp`
- Transport: Streamable HTTP
- How users reach the server: Universal URL

### Authentication

- Mode: OAuth (Dynamic Client Registration). CIMD is also advertised
  (`client_id_metadata_document_supported`) if the portal prefers it.
- Not Anthropic-held client credentials (no need unless DCR/CIMD fails).
- Not a custom per-customer URL.
- Tools do not prompt for auth individually; the MCP connection is OAuth first.
  Approving is one grant
  ([0049](./decisions/0049-no-mcp-capability-oauth-scopes.md)).

### Use cases

Primary use cases:

- Remember facts and preferences across Claude conversations
- Send yourself email and look up replies in the Kody inbox
- Schedule jobs that keep running when Claude is closed
- Connect GitHub, Google, Discord, or another provider, then act through Kody
- Save a working execute module as a package you own

What users need before they connect:

- A Kody account with a verified email (`https://kody.codes/signup`)
- Optional: a connected provider (GitHub, Google, …) for those use cases
- Any Claude plan can add a custom connector; the directory listing is how other
  people discover the same URL

Reads, writes, or both: **both**. `search` only reads. `execute` can write.

### Data handling

- Underlying API: Kody's own first-party API on `kody.codes`. `execute` may also
  call user-authorized third-party APIs the user connected in Kody (OAuth tokens
  stored per user). That is a user-granted proxy, not an unlicensed scrape.
- Personal health data: no
- Sponsored content: no

### Compliance acknowledgments (all required)

Answer from the product as it works today:

- Directory guidelines: yes, if you have read the two Anthropic policy pages
- First-party API: yes for Kody primitives; connected-provider calls use the
  user's own credentials
- Financial transactions: MCP tools do not transfer money or crypto. Stripe is
  billing for Kody plans only. A user who connects a payment API could call it
  from `execute` — say that if asked
- AI media generation: Kody does not ship image/video/audio generation as a
  connector feature
- Prompt injection: tool descriptions stay functional (no host-behavior
  instructions)
- Conversation data: tools do not query Claude memory, chat history, or user
  files
- Public documentation: yes, at `https://kody.codes/docs`

## Test & launch (Kent)

Do not put passwords, magic links, or OAuth client secrets in this repo.

**TODO (Kent):** mint a dedicated reviewer account on production (`kody.codes`),
not a customer account and not the operator login.

Populate it so every tool looks real:

- Verified email
- A few memories
- One saved package the reviewer can inspect
- One scheduled job or workflow run
- At least one inbox message (notify-self is enough)
- Optional: one throwaway connected integration (not Kent's personal GitHub or
  Google)

Write step-by-step access instructions for someone who has never used Kody:
signup or login URL, 2FA if enabled, how to complete OAuth from Claude, and how
to reset after a destructive execute.

Reviewer prompts that exercise both tools:

1. `search({ query: "what can you do" })`
2. `search({ entity: "package_authoring:guide" })`
3. `search({ domain: "email" })`
4. execute the notify-self snippet from email capability detail
5. execute a package or capability that writes a memory, then search again

Confirm you ran every tool in MCP Inspector and as a custom connector before
submit.

## Network note

Anthropic egress is `160.79.104.0/21`. If Claude cannot `initialize`, check
WAF/CDN 403s that the app did not generate. OAuth discovery, registration, and
token endpoints should respond in under 10 seconds.

## After publish

Tool changes deploy with the worker; Anthropic does not require a resubmit for
new tools. Listing metadata edits go through the submissions dashboard. The slug
does not change. Keep the Claude metadata test green when adding a tool:
`title`, name ≤ 64, and `readOnlyHint` or `destructiveHint`.
