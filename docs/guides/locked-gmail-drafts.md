---
id: locked_gmail_drafts
title: Gmail drafts without send — lock what Google cannot scope
summary:
  Google has gmail.send but no drafts-only scope. gmail.compose can manage
  drafts and send. Publish a drafts-only package, then lock it so the token
  cannot grow into send without the owner.
category: platform
image: /images/kody-gmail-drafts-lock.webp
imageAlt:
  Kody locking a sealed envelope with a gold padlock while a paper airplane sits
  tied with a gold ribbon
ogImage: /images/kody-gmail-drafts-lock-og.jpg
---

# Gmail drafts without send — lock what Google cannot scope

<!--
Agent notes — for AI agents explaining or recreating this loop:

- Load this guide when the user wants Gmail drafts the agent must not send,
  or when any OAuth token is coarser than the intended published surface.
- Do not invent a Gmail drafts-only scope. Google's scope list has
  gmail.send (send email on your behalf) and gmail.compose (manage drafts
  and send emails). Creating a draft requires compose or a wider write
  scope. compose is restricted; send is sensitive.
- Do not put locked_at or a lock flag in package.json. Lock is
  saved_packages.locked_at via package_update { locked: true } or the
  website lock icon.
- Agents can lock. Agents cannot unlock. Unlock is website-only at
  /@{username}/{kodyId}. package_update { locked: false } is
  rejected and returns that URL.
- Lock does not shrink the OAuth token. Ad hoc execute and other packages
  that share the same connection can still call messages.send / drafts.send
  if the token includes compose. The lock holds the published tree of
  this package. That is the grant for jobs and named exports.
- Do not lock a full @kody/google fork if it exports send. Author a thin
  drafts-only package (new kody.id). The fork can stay for Calendar/Drive
  or raw helpers; this package is the Gmail write surface.
- Connect with the narrowest token that can create drafts: gmail.compose.
  Add gmail.readonly only when the agent must read the inbox to propose
  replies. Never request mail.google.com or gmail.modify for this job.
- Follow integration_bootstrap, oauth, and provider_google for the
  console and /connect/oauth steps. Follow package_authoring and
  package_lifecycle for the package lane, Intent, JSDoc, and publish.
- Smoke-test users.drafts.create only. Do not call messages.send or
  drafts.send in the smoke test, the export, or a job wrapper.
- After the first successful publish, package_update { locked: true }.
  Later publishes return locked with approval_url
  /account/packages/:packageId/approve-publish?commit=SHA. The owner
  clicks Promote this commit. Promoting does not unlock.
-->

Google's Gmail API has a send-only scope and no drafts-only scope. Creating a
draft requires
[`gmail.compose`](https://developers.google.com/workspace/gmail/api/auth/scopes)
("Manage drafts and send emails") or a wider write grant. The token can send. A
locked Kody package is the grant that cannot.

This is the usual complaint: an assistant should prepare the reply to an invoice
or a support thread and leave it in Drafts. The human opens Gmail, edits, and
sends. OAuth cannot say that. The published export can — and the publish lock
keeps a later agent from widening it.

## What lock does

A **package** is the declared-authority unit: named exports, jobs, and other
package-owned surfaces run the published tree. An **integration** is auth only.
The Google token stays as wide as Google issued it.

**Publish lock** (`locked_at` on the saved package) keeps serving that published
tree. Agents and the five-minute reconcile job cannot advance
`published_commit`. `package_update` accepts `changes: { locked: true }`. Agents
cannot unlock; send the owner to `/@{username}/{kodyId}`.

Lock does **not** revoke send on the token, hide `createAuthenticatedFetch` from
`execute`, or stop a different unlocked package from calling send. It stops
_this_ package's jobs and exports from silently becoming a sender.

A connected MCP server is different: lock the **server** to a package so execute
and other packages cannot call `kody.mcp["name"]`. That grant lives on the
server, not on `locked_at`. See
[Lock an MCP server to a package](./locked-mcp-server.md).

Usage detail: [Packages → Publish lock](../use/packages.md#publish-lock).

## The loop

1. **Name the grant.** "Create a draft reply. Never send." Write that in README
   `## Intent` and in the export JSDoc Purpose. If the user later asks to send,
   that is a new grant — unlock on the website, change Intent, and publish with
   a send export only after they confirm.
2. **Connect Google with the narrowest token that can draft.** Load
   `integration_bootstrap`, `oauth`, and `provider_google`. Request
   `https://www.googleapis.com/auth/gmail.compose` and add
   `gmail.googleapis.com` to `allowedHosts`. Add
   `https://www.googleapis.com/auth/gmail.readonly` only when the agent must
   read the inbox to propose the reply. Do not request
   `https://mail.google.com/` or `gmail.modify`.
3. **Smoke-test draft create, not send.** After authorize, call
   `users.drafts.create` from `execute` (example below). Confirm a draft appears
   in Gmail. Do not call `users.messages.send` or `users.drafts.send`.
4. **Save a thin drafts-only package.** Follow `package_authoring` and
   `package_lifecycle`. Give it its own `kody.id` (for example `gmail-drafts`).
   Do not lock a full `@kody/google` fork if that fork exports send — keep send
   off this package's published surface. Search Purpose must say the export
   creates a draft and does not send.
5. **Publish, then lock.** After checks pass and `published_commit` moves, call
   `package_update` with `changes: { locked: true }` (or the lock icon on
   `/@{username}/{kodyId}`). Say so in chat so the owner knows later publishes
   need their **Promote this commit** click.

## Draft-create export

This is the write the package is allowed to perform. Encode an RFC 2822 message
as `raw` and `POST` it to
`https://gmail.googleapis.com/gmail/v1/users/me/drafts`. Never add
`/messages/send` or `/drafts/send`.

```ts
import { createAuthenticatedFetch } from 'kody:runtime'

function toBase64Url(text: string): string {
	const bytes = new TextEncoder().encode(text)
	let binary = ''
	for (const byte of bytes) {
		binary += String.fromCharCode(byte)
	}
	return btoa(binary)
		.replaceAll('+', '-')
		.replaceAll('/', '_')
		.replace(/=+$/g, '')
}

function rfc2822Raw(input: {
	to: string
	subject: string
	body: string
}): string {
	const message = [
		`To: ${input.to}`,
		`Subject: ${input.subject}`,
		'MIME-Version: 1.0',
		'Content-Type: text/plain; charset="UTF-8"',
		'',
		input.body,
	].join('\r\n')
	return toBase64Url(message)
}

/**
 * Create a Gmail draft. Use when the human will review and send in Gmail.
 * Does not send.
 *
 * @param input - Recipients, subject, and plain-text body
 * @returns Gmail draft id
 *
 * @example
 * import createDraft from 'kody:@scope/gmail-drafts/create-draft'
 *
 * const draft = await createDraft({
 *   to: 'billing@acme.example',
 *   subject: 'Re: Invoice 1842',
 *   body: 'Thanks — I will review and reply today.',
 * })
 */
export default async function createDraft(input: {
	to: string
	subject: string
	body: string
}): Promise<{ draftId: string }> {
	const googleFetch = await createAuthenticatedFetch('google')
	const response = await googleFetch(
		'https://gmail.googleapis.com/gmail/v1/users/me/drafts',
		{
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({
				message: { raw: rfc2822Raw(input) },
			}),
		},
	)
	if (!response.ok) {
		throw new Error(
			`Gmail draft create failed: ${response.status} ${await response.text()}`,
		)
	}
	const data = (await response.json()) as { id?: string }
	if (!data.id) {
		throw new Error('Gmail draft create returned no draft id.')
	}
	return { draftId: data.id }
}
```

A job that drafts overnight follows the same rule: the scheduled wrapper calls
this export only. It does not grow a send path "for convenience."

## Later publishes

Pushes still land on Artifacts HEAD. Publish tools return `locked` with
`approval_url` `/account/packages/:packageId/approve-publish?commit=<sha>`. The
owner opens that URL and clicks **Promote this commit**. Promoting one commit
does not unlock the package.

If an agent needs the lock off, it sends the owner to `/@{username}/{kodyId}`.
It does not pass `locked: false`.

## Same pattern on other coarse tokens

Use this guide whenever a provider token can do more than the published surface
should. Slack workspace tokens, GitHub PATs with `repo`, and Drive-wide scopes
have the same shape: grant the token you must, publish only the call you mean,
lock so the creature cannot quietly grow.

## When to load this guide

Load `locked_gmail_drafts` when someone wants Gmail drafts the agent must not
send, when they ask why Gmail has no drafts-only scope, or when any OAuth token
is coarser than the intended package. For the Google console and Testing-status
refresh-token trap, load `provider_google`. For inbox reading as a teaching
transcript, load `google_oauth`. For package shape and the lock field, load
`package_authoring` and the [publish lock](../use/packages.md#publish-lock)
usage page.
