---
id: triggers
title: Jobs, workflows, and webhooks
summary:
  How work runs when nobody is in the chat. Package-owned jobs for recurring
  schedules, workflows for deferred or long one-shot runs, inbound webhooks for
  provider events, subscriptions for events inside Kody, and the inbox — which
  to pick, how each is declared, and how to test one safely before enabling it.
  Load this when someone asks how to run something later, on a schedule, or when
  a provider knocks.
category: platform
---

# Jobs, workflows, and webhooks

Everything your agent builds in Kody can run without the agent. That is the
difference between an automation and a chat transcript. Kody has four ways to
start work when nobody is typing, and every one of them runs a package you own —
no model in the loop, no tokens spent.

| You want to run…                                      | Use                    |
| ----------------------------------------------------- | ---------------------- |
| The same thing on a schedule                          | a **job**              |
| One thing later, or something longer than a request   | a **workflow**         |
| Something when Sentry, GitHub, Stripe, or a CLI POSTs | an inbound **webhook** |
| Something when Kody itself emits an event             | a **subscription**     |

Prefer the event that actually describes the moment — a webhook or a
subscription — and reach for a schedule when no event exists. Cron is fine; it
is just not the hero.

## Jobs — recurring schedules that travel with the package

A job is declared in the package manifest, so the schedule ships with the
behavior it runs:

```json
{
	"kody": {
		"jobs": {
			"daily-digest": {
				"entry": "./src/daily-digest.ts",
				"schedule": { "type": "cron", "expression": "0 8 * * *" },
				"timezone": "America/Denver",
				"enabled": false
			}
		}
	}
}
```

- The entry is a package-local module with no arguments. The usual shape is a
  thin wrapper that calls a callable export and sends notify-self mail only when
  there is something to say.
- Publish with `"enabled": false`, invoke the wrapper once from `execute` to
  prove it, then enable. A schedule you have never run once is a schedule you
  will debug at 8 a.m.
- Each run gets a job-scoped scratch bucket; shared durable state (cursors, the
  last seen id) belongs in `packageStorage()`.
- `jobUpdate` adjusts schedule, timezone, enabled state, params, and
  `expires_at`; `jobRunNow` fires one run for debugging. Name and source stay in
  the repo — change them there and publish.

Jobs do not hang off an integration or an MCP connection. If a "job" has no
package, save the package first. Runs show up on `/account/jobs`.

## Workflows — deferred and durable one-shot work

A workflow is a durable run Kody executes later, outside the request that asked
for it. Use one instead of plain `execute` for:

- **later** — `runAt` in the future ("remind me Friday", "retry after the
  window")
- **longer** — batch sweeps, migrations, polling loops, or steps that would
  exceed execute's ~90 second budget; workflow steps get a longer sandbox
- **once** — an `idempotencyKey` makes a repeated `create` return the existing
  run instead of starting a duplicate

```ts
import { workflows } from 'kody:runtime'

export default async function main() {
	return await workflows.create({
		exportName: './rebuild-index',
		runAt: new Date(Date.now() + 15 * 60_000),
		idempotencyKey: 'rebuild-index:2026-09-08',
	})
}
```

`workflows.create` takes either `code` (a complete module string) or
`exportName` (a saved-package export). Inspect runs with `workflowRunList`,
cancel with `workflowRunCancel`; they appear on `/account/workflows`. Recurring
work is a job, not a workflow that reschedules itself.

## Inbound webhooks — the external HTTP knock

A webhook gives a package a public, credentialed URL. A provider POSTs to it and
Kody dispatches the validated request to the package export that owns it.

1. Declare it under `package.json#kody.webhooks`: a `name`, the `export` it
   binds to, and (for vendor senders) `verification` — HMAC header, encoding,
   and the **name** of the signing secret in your secret store. One webhook name
   binds one export; there is no wildcard.
2. Store the signing secret with `secretSet` under that name.
3. Mint the URL with `webhookUrlMint` and paste it into the provider. The URL
   secret is returned only on mint or rotate — treat the URL as a credential.

Declaring a webhook does not open ingress; minting does. Deliveries are
rate-limited per webhook (default 60 per minute, at most 600), and body-only
HMAC is replayable unless you opt into a timestamp window or delivery-id header.
Full contract and payload shapes: [Inbound webhooks](../use/webhooks.md).

Sentry noise, GitHub events, Stripe payments, a shortcut on your phone, a CLI on
your laptop — anything that can POST JSON can start a package this way.

## Subscriptions — events from inside Kody

When the trigger is something Kody already knows about — a message landing in
your inbox, a repo push, a run error, an integration losing auth — a package
subscribes to that topic in `package.json#kody.subscriptions` and Kody invokes
the handler with the event payload. `packageSubscriptionDispatch` sends a
synthetic event so you can test a handler before the real one arrives. Topics,
payloads, and package-emitted events:
[Subscriptions and events](./package-subscriptions.md).

## The inbox is a trigger too

Every account has an email address. Mail that arrives there is stored and emits
`email.message.received`, so "forward it to Kody" is a valid trigger for people
and systems that can send email but cannot call an API. The same inbox is how a
job tells you it finished: `emailSend` mails the account's own address and
nothing else. See [Email primitives](../use/email-primitives.md).

## Choosing well

- A schedule is optional, not the point. If the person cannot name a time they
  want something to happen, leave the trigger off and let them ask.
- Test before you enable: invoke the wrapper from `execute`, dispatch a
  synthetic event, or send yourself one webhook.
- Keep the wrapper quiet. Notify only when there is news; an empty digest every
  morning trains people to ignore the real one.
- Failures and recent runs for every trigger live on `/account/activity`.

## Where to go next

- [Package lifecycle](./package-lifecycle.md) — testing a scheduled wrapper
  before enabling its schedule.
- [How Kody works](./how-kody-works.md) — one loop from ad hoc question to a
  daily email that stays quiet until something ships.
- [Workflows](../use/workflows.md) — the full `workflows.create` reference.
