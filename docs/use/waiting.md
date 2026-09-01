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
  disconnected
- review a locked package (published code stays put until you promote or unlock)
- confirm a pending email change
- a plan resource at its cap
- an elevated error rate (one card that points at Activity)
- unfinished onboarding steps, unless you dismissed the checklist

Vendor outages, operator work, and other people's queues do not appear here.
Session-scoped secret approvals stay on the session that requested them.

OAuth integration last-failure is not stored, so a dead third-party grant does
not invent a Waiting row. Reconnect from
[Integrations](https://kody.codes/account/integrations) or the MCP server page
the card already links to.

## Not Activity, not Email

- **[Activity](./activity.md)** is run history: jobs, apps, webhooks, and
  triage. Waiting does not copy that error list.
- **[Email](./email-primitives.md)** is your mailbox. Waiting does not send
  mail.

## Ask your agent

`waitingSummary` lives on the existing `account` domain. It returns the same
self-scoped items as the page. Use `runSummary` when you want Activity.
