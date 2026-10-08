---
id: mcp_events
title: MCP Events from packages
summary:
  Opt a package topic into MCP Events so ChatGPT (and other webhook-capable MCP
  clients) can subscribe. Delivery reuses the same package event bus as
  kody.subscriptions. Behind the mcp-events-extension flag.
category: platform
audience: agents
---

# MCP Events from packages

MCP Events let a connected host subscribe to things your packages emit — a
Discord message, a checkout, a job finishing — and wake the agent when they
happen. Kody implements the **webhook-only** profile of the draft MCP Events
extension (design sketch 2026-02-19; OpenAI ChatGPT profile on protocol
`2026-07-28`). Poll and push delivery are out of scope.

This surface is behind the `mcp-events-extension` feature flag. Signed-in users
can turn it on from this page. Experimenters get it when operators enable the
flag for the experiments audience.

Package subscriptions between your own packages stay on
[Package subscriptions and events](./package-subscriptions.md). MCP Events is
the same bus exposed to an external MCP client.

## What you get

When the flag is on **and** the MCP client advertises events support:

1. `/mcp` advertises an `events` capability on `server/discover`.
2. The client can call `events/list`, `events/subscribe`, and
   `events/unsubscribe`.
3. Matching package `events.dispatch` calls POST a Standard Webhooks-signed
   payload to the client's callback URL.

The tool surface stays `search` / `execute` / `api`. Nothing is exposed by
default: each topic opts in with `"mcp": true` on its `kody.emits` entry.

## Clients that consume it today

| Client                                                  | Support                                                                        |
| ------------------------------------------------------- | ------------------------------------------------------------------------------ |
| ChatGPT (Work chats on web; desktop Work + Cloud; dots) | Webhook MCP Events on protocol `2026-07-28`                                    |
| Other MCP hosts                                         | Only if they advertise events support and implement webhook subscribe/delivery |

Cursor, Claude, and other hosts that do not advertise the extension keep today's
behavior: no `events` capability, and `events/*` methods are not registered.

## Opt a topic into MCP

Declare the topic in `package.json#kody.emits` as usual, and set `mcp: true`:

```json
{
	"name": "@you/ping-notifier",
	"exports": {
		".": "./src/index.ts"
	},
	"kody": {
		"description": "Emits a ping event an MCP host can subscribe to.",
		"emits": {
			"@you/ping.ready": {
				"description": "A ping was requested.",
				"mcp": true,
				"payloadSchema": {
					"type": "object",
					"properties": {
						"message": { "type": "string", "minLength": 1 }
					},
					"required": ["message"],
					"additionalProperties": false
				}
			}
		}
	}
}
```

Rules:

- Omit `mcp` or set `"mcp": false` to keep the topic package-internal (same-user
  `kody.subscriptions` still work).
- The MCP event **name** is the topic string (`@you/ping.ready`).
- v1 subscriptions take no filter arguments (`inputSchema` is an empty object).
- Payloads still follow the package-event 64 KiB cap; MCP delivery allows up to
  256 KiB for the full webhook body.

## Emit

Same helper as package-to-package events:

```ts
import { events } from 'kody:runtime'

export default async function ping(input: { message: string }) {
	await events.dispatch({
		topic: '@you/ping.ready',
		idempotencyKey: `ping:${input.message}:${Date.now()}`,
		payload: { message: input.message },
	})
	return { ok: true as const }
}
```

Dispatch stays asynchronous: validate → enqueue on
`kody-package-events-dispatch` → deliver to package subscribers **and** any
matching MCP subscriptions for the same user. There is no second dispatch path.

## Subscribe and delivery

1. The host calls `events/list` and sees only MCP-opted topics from packages the
   connection may read (connection-profile grants apply).
2. The host calls `events/subscribe` with the event name, a HTTPS callback URL,
   and a `whsec_…` signing secret.
3. Kody verifies the callback with a signed challenge, then stores the
   subscription (TTL default 1 hour, max 24 hours; refresh before expiry).
4. When your package dispatches, Kody POSTs one Standard Webhooks-signed event
   per subscription:

```http
POST /mcp-events/callback
Content-Type: application/json
webhook-id: evt_…
webhook-timestamp: 1739980800
webhook-signature: v1,…
X-MCP-Subscription-Id: sub_…

{
  "eventId": "evt_…",
  "name": "@you/ping.ready",
  "timestamp": "2026-10-07T12:00:00.000Z",
  "data": { "message": "hello" },
  "cursor": null
}
```

Subscriptions stop delivering when the OAuth client is revoked, the password
changes, or the TTL expires without refresh. Revoke and password-change paths
delete the rows immediately; an expired TTL only stops delivery until a later
`events/subscribe` from that principal prunes the stale row. Same-user scoping
is unchanged: events never cross accounts.

## Try it

1. Turn the flag on with the button on this page (or opt into experiments and
   wait for the experiments audience enable).
2. Publish a package with an `mcp: true` topic (example above).
3. Connect ChatGPT (or another events-capable host) to your Kody MCP server.
4. Ask the host to monitor `@you/ping.ready` and say what to do when it fires.
5. `execute` the package export that dispatches the event.

Further reading: [Package subscriptions and events](./package-subscriptions.md),
[ADR 0059](../contributing/decisions/0059-mcp-events-extension-behind-flag.md).
