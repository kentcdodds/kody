# Email primitives

Kody has a storage-first email surface for Cloudflare Email Service and Email
Routing. It can send from verified identities, receive routed mail, and store
parsed messages for later automation.

## Capabilities

Use the MCP `email` domain:

- `email_inbox_create` creates an inbox and routable alias.
- `email_inbox_list` lists inboxes and aliases for the signed-in user.
- `email_sender_identity_verify` verifies an outbound sender identity.
- `email_send` sends outbound mail from a verified sender identity.
- `email_reply` replies to a stored inbound message.
- `email_attachment_get` returns stored attachment bytes by attachment id.
- `email_message_list` lists stored inbound and outbound messages.
- `email_message_get` returns parsed bodies, headers, thread metadata, and
  attachment metadata.

## Safety model

- Any email routed to a configured Kody inbox is stored.
- Unknown aliases are rejected before storage.
- Display names are not trusted. Kody stores envelope sender, parsed `From`, and
  authentication headers separately.
- Outbound sending requires a verified sender identity.
- Stored inbound mail is the source of truth. If a user wants email automation,
  they can publish a package that subscribes to the stored inbound email topic
  `email.message.received` using normal package subscriptions. This is package
  behavior, not a separate Kody-owned email handler or agent-loop primitive.
- Subscription event payloads are metadata-first. Package handlers receive the
  stored message id and receipt metadata, then use `email_message_get` or
  `email_attachment_get` (or `import { email } from 'kody:runtime'`) when they
  need bodies or attachment bytes.
- Subscription handlers run with the normal package runtime context: signed-in
  package user, package-owned storage `package:<packageId>`, package/repo
  context, and the standard capability registry subject to the usual secret and
  capability approval rules. For `email.message.received`, `import { email }`
  from `kody:runtime` is available as a convenience helper for message lookup,
  attachment lookup, and replies.
- Attachments are metadata-first by default; raw MIME for small messages is
  stored so on-demand attachment lookup can reconstruct bytes locally.

## `email.message.received` package subscription

Stored inbound email currently dispatches the package subscription topic
`email.message.received` after the message and attachment metadata are stored.
Packages subscribe in `package.json#kody.subscriptions`:

```json
{
	"kody": {
		"subscriptions": {
			"email.message.received": {
				"handler": "./src/on-email-message-received.ts",
				"description": "Process stored inbound mail."
			}
		}
	}
}
```

Handlers receive a metadata-first payload:

```ts
type EmailMessageReceivedEvent = {
	event: 'email.message.received'
	message: {
		id: string
		inbox_id: string | null
		from_address: string | null
		envelope_from: string | null
		to_addresses: Array<string>
		cc_addresses: Array<string>
		reply_to_addresses: Array<string>
		subject: string | null
		message_id_header: string | null
		in_reply_to_header: string | null
		references: Array<string>
		processing_status: 'stored' | 'sent' | 'failed'
		received_at: string | null
		created_at: string
	}
	attachments: Array<{
		id: string
		filename: string | null
		content_type: string | null
		content_id: string | null
		disposition: string | null
		size: number
		storage_kind: string
		storage_key: string | null
		created_at: string
	}>
}
```

The event does not include parsed bodies or attachment bytes. Fetch those only
when the handler needs them with `email_message_get`, `email_attachment_get`, or
the package runtime `email` helper. Use `package_subscription_list` with
`topic: "email.message.received"` to discover which saved packages currently
subscribe for the signed-in user.

## Local inbound testing

Run the worker locally, create an inbox alias, then post raw MIME to Wrangler's
email test endpoint. The local worker defaults to port `3742` unless you set
`PORT`:

```sh
curl --request POST \
  'http://localhost:3742/cdn-cgi/handler/email?from=sender@example.com&to=alias@example.com' \
  --data-raw 'From: Sender <sender@example.com>
To: Alias <alias@example.com>
Subject: Hello
Message-ID: <hello@example.com>

Hello from local email routing.'
```

Then inspect the message with `email_message_list` and `email_message_get`.
