# Email primitives

Kody has a storage-first email surface for Cloudflare Email Service and Email
Routing. Every user gets an automatic inbox address at
`{username}@<platform domain>` (the hostname of the deployment's `APP_BASE_URL`,
for example `you@heykody.dev`). Kody receives routed mail for that address,
stores parsed messages for later automation, and can send notify-self mail and
replies from the matching platform-assigned sender address.

## Addressing model

- Inbound mail to `{username}@<platform domain>` routes to the user who owns
  that username. The default inbox is provisioned automatically at signup (or on
  the first inbound message), so there is nothing to create or configure.
- Mail to unknown usernames is rejected.
- Reserved local parts (`kody`, `postmaster`, `abuse`, and other role or system
  names) never route to a user inbox and can never be registered as usernames.
  `kody@<platform domain>` is the system transactional sender (verification and
  password-reset mail) only.
- User outbound mail always sends from `{username}@<platform domain>`. The from
  address is platform-assigned; there is no self-service sender verification.

## Capabilities

Use the MCP `email` domain:

- `email_inbox_list` lists inboxes and automatic platform addresses for the
  signed-in user.
- `email_send` sends a notification email to your own account email address
  (notify-self only; any other recipient is rejected).
- `email_reply` replies to a stored inbound message. The recipient always comes
  from the stored message.
- `email_attachment_get` returns stored attachment bytes by attachment id.
- `email_message_list` lists stored inbound and outbound messages.
- `email_message_get` returns parsed bodies, headers, thread metadata, and
  attachment metadata.

## Safety model

- Any email routed to a user's platform address is stored.
- Unknown usernames and reserved local parts are rejected before storage.
- Display names are not trusted. Kody stores envelope sender, parsed `From`, and
  authentication headers separately.
- Outbound sending requires a verified account email, sends only from the
  platform-assigned address, and `email_send` only delivers to the signed-in
  user's own account email. `email_reply` is the only way to address external
  recipients, and only recipients taken from stored inbound mail.
- Outbound sends consume a per-day entitlement. Users without a plan are capped
  by a global daily backstop instead of sending unlimited mail.
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

Stored inbound email dispatches the package subscription topic
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
the package runtime `email` helper. Use `package_subscriptions_list` with
`topic: "email.message.received"` to discover which saved packages subscribe for
the signed-in user.

## Local inbound testing

Run the worker locally with `APP_BASE_URL` set, sign up a user, then post raw
MIME to Wrangler's email test endpoint addressed to
`{username}@<APP_BASE_URL hostname>`. The local worker defaults to port `3742`
unless you set `PORT`:

```sh
curl --request POST \
  'http://localhost:3742/cdn-cgi/handler/email?from=sender@example.com&to=username@example.com' \
  --data-raw 'From: Sender <sender@example.com>
To: Username <username@example.com>
Subject: Hello
Message-ID: <hello@example.com>

Hello from local email routing.'
```

Then inspect the message with `email_message_list` and `email_message_get`.
