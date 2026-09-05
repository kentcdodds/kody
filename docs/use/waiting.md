# Waiting

Waiting is the current-state queue of things only **you** can clear. Open
**`/account/waiting`** while signed in — the header avatar lands here.

Items are derived from live account state. They disappear when the gate clears.
There is no read/unread mark, archive, or notification table.

The empty state is **Nothing is waiting on you.**

## What shows up

Typical items:

- verify your email (outbound mail stays off until you confirm)
- finish OAuth or reconnect an MCP server that is authenticating, failed, or
  disconnected — unless the error looks like a vendor outage
- reconnect a third-party grant that last refresh classified as yours to fix
  (`invalid_grant`, missing refresh token, missing user credential)
- update an expired user-scope secret (up to three, then a “more” card)
- review a locked package (published code stays put until you promote or unlock)
- confirm a pending email change
- a plan resource at its cap
- an elevated **open** error rate (one card that points at Activity; ignored and
  resolved runs do not keep it around)
- unfinished onboarding steps, unless you dismissed the checklist

Vendor outages, operator work, and other people's queues do not appear here.
Session-scoped secret approvals stay on the session that requested them. Missing
secret _names_ stay off Waiting (the agent’s `nextStep` and
`/account/secrets/new` already cover those).

OAuth last-failure **is** stored on the connection. A reconnectable grant shows
a Waiting card with Reconnect. A provider 5xx or timeout is stored for
[Integrations](https://kody.codes/account/integrations) as a service issue, but
it does not appear here and does not emit `integration.auth.failed`.

## Not Activity, not Email

- **[Activity](./activity.md)** is run history: jobs, apps, webhooks, and
  triage. Waiting does not copy that error list.
- **[Email](./email-primitives.md)** is your mailbox. Waiting does not send
  mail.

## Ask your agent

`waitingSummary` lives on the existing `account` domain. It returns the same
self-scoped items as the page. Use `runSummary` when you want Activity.
