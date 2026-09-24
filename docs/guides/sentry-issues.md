---
id: sentry_issues
title: Sentry Issues
summary:
  Homepage webhook example: a package-owned inbound URL that accepts a Sentry
  issue POST, verifies HMAC on the platform, and starts triage without a model
  in the request path. Load this when someone asks how Sentry Issues works or
  how to hang a vendor webhook on a package they own.
category: platform
---

# Sentry Issues

The homepage **Trigger it** card labeled Webhook is this example. Sentry (or any
vendor that can POST JSON) knocks on a credentialed URL Kody hosts. The bound
package export runs. No chat, no inference, no tokens spent on the delivery
itself.

Live public package:
[`@kentcdodds/sentry-triage`](https://kody.codes/@kentcdodds/sentry-triage).
Fork that public package when you want the same issue door on your Sentry
projects. The HTTP contract is in [Inbound webhooks](../use/webhooks.md). The
"which trigger" guide is [Jobs, workflows, and webhooks](./triggers.md).

## The knock

A new issue in a configured Sentry project POSTs to a minted URL. Kody verifies
the HMAC against a named secret, then invokes the package export declared on
that webhook. Fast skips stay synchronous. Durable triage (Discord status, Seer
RCA, waking an agent) is extra work the package chooses to stage after the ack.

Kent's copy wakes Cole (Grok Bot) per issue, keeps one Discord status message
per issue, and never auto-spawns Cursor from the webhook path. Cole may spawn
Cursor later when isolated repo work is the right tool. Your fork can stop at
"verify, store, notify" if you do not want an agent in the loop. Either way the
package, not a model, receives every delivery; an agent wakes only when the
package decides to stage that work.

Sentry event text is untrusted data. Treat titles, breadcrumbs, and request
bodies as attacker-controlled.

## Package shape

Declare the webhook in `package.json#kody.webhooks`. One name binds one export.
Declaring it does not open ingress; minting does.

```json
{
	"name": "@you/sentry-triage",
	"exports": {
		"./handle-sentry-webhook": "./src/handle-sentry-webhook.ts"
	},
	"kody": {
		"webhooks": [
			{
				"name": "sentry",
				"export": "./handle-sentry-webhook",
				"responseMode": "ack",
				"verification": {
					"type": "hmac-sha256",
					"header": "sentry-hook-signature",
					"secretName": "sentryWebhookSecret",
					"encoding": "hex"
				}
			}
		]
	}
}
```

The handler sees the validated request, not a chat transcript:

```ts
export default async function handleSentryWebhook(input: {
	request: { json?: Record<string, unknown> }
}) {
	const action = input.request.json?.action
	const issue = (
		input.request.json?.data as { issue?: { id?: string; title?: string } }
	)?.issue
	if (!issue?.id) return { ok: true, skipped: 'no-issue' }
	// Stage durable work; ack stays fast.
	return { ok: true, issueId: issue.id, action }
}
```

Setup, in order:

1. Save the signing secret with `secretSet` under `sentryWebhookSecret`. The
   platform resolves it at delivery time. Do not paste the value into chat.
2. Publish the package.
3. Mint with `webhookUrlMint` (`kody_id` + `webhookName: "sentry"`). The tool
   returns a `handle`, not the URL.
4. For Sentry, the owner copies the URL from the package settings page
   (`/@<username>/<packageKodyId>/settings#webhooks`) and pastes it into the
   Sentry internal integration. MCP and execute never return the credential.
5. Smoke-test before you trust production: send yourself one delivery, or invoke
   the export from `execute` with a `kodyDryRun` payload.

Kent's handler acks quickly, stages the full body in `packageStorage()`, and
dispatches `./process-sentry-webhook` through `workflows.create` with a bounded
`{ payloadKey, issueId, resource, action }` object. A late, large Sentry POST
does not have to finish triage inside the webhook budget.

Rotate, reveal, and the cross-package index live on the package settings
**Webhooks** section and `/account/webhooks`. The rotate overlap window is in
[Inbound webhooks](../use/webhooks.md).

## Example prompts

**Build one**

> Search Kody for sentry issues and inbound webhooks. I want a package that
> accepts Sentry issue webhooks, verifies HMAC with a named secret, acks fast,
> and mails me the new issue id. Do not put the URL in chat. After publish, mint
> the webhook and tell me to paste the URL from package settings into Sentry.

**Fork the public one**

> Open https://kody.codes/@kentcdodds/sentry-triage and fork it. Call `./adapt`
> first and walk me through the owner-specific swaps (Sentry projects, Discord
> channel, secrets). Keep the live `sentry` webhook on Kent's package alone.

**Dry-run an existing copy**

> Import `kody:@me/sentry-triage/handle-sentry-webhook` and invoke it with
> `{ request: { json: { action: "created", kodyDryRun: true, data: { issue: { id: "1", title: "smoke" } } } } }`.
> Show me what it would do without waking anyone.

## What you see

| Surface                     | What it is for                                                         |
| --------------------------- | ---------------------------------------------------------------------- |
| Package settings → Webhooks | Mint, reveal, rotate, disable, enable. Reveal is audit-logged          |
| `/account/webhooks`         | Every webhook across packages, with links to those settings sections   |
| `/account/activity`         | Delivery metadata and handler runs. Bodies are never stored there      |
| Discord (Kent's copy)       | One status card per issue, edited in place from start to finish        |
| Chat (`execute`)            | Dry-run the handler, `./reset-issue`, `./triage-report`, `./reconcile` |

The homepage card is a tile with the kicker **Webhook** and the title **Sentry
Issues**. It links here.

## Where to go next

- [Inbound webhooks](../use/webhooks.md) — HMAC, replay windows, mint/rotate,
  trusted clients.
- [Jobs, workflows, and webhooks](./triggers.md) — when a webhook is the right
  door versus a cron or a subscription.
- [Agent inbox](./agent-inbox.md) — the email sibling on the same homepage row.
- [Package authoring](./package-authoring.md) — README Intent, AGENTS.md, and
  publish checks.
