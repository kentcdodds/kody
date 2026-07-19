# Package subscription guide

Use package subscriptions when a saved package should react to Kody-owned event
topics. The saved package remains the top-level entity; subscriptions are nested
manifest metadata and package runtime handlers.

## Manifest shape

Declare subscriptions in `package.json#kody.subscriptions` as a record keyed by
event topic:

```json
{
	"name": "@scope/email-automation",
	"exports": {
		".": "./src/index.ts"
	},
	"kody": {
		"id": "email-automation",
		"description": "Automates stored inbound email.",
		"subscriptions": {
			"email.message.received": {
				"handler": "./src/on-email-message-received.ts",
				"description": "Process stored inbound mail."
			}
		}
	}
}
```

Each subscription definition supports:

- `handler` (required): package-local module path for the event handler.
- `description` (optional): human-readable purpose for package detail and
  subscription listings.
- `filters` (optional): topic-specific metadata reserved for dispatchers.

Package checks normalize handler paths and build published bundle artifacts for
subscription handlers. Runtime dispatch invokes the handler through the normal
package execution path with package context, package-owned storage,
package-owned secrets, and `kody:runtime`.

## Discovery

Use `search` for package subscription work, then call the built-in
`package_subscriptions_list` capability to inspect the signed-in user's declared
subscriptions:

```json
{
	"topic": "email.message.received"
}
```

The result lists package id, `kody.id`, package name, topic, handler,
description, and filters. Use this before debugging event dispatch, building
fan-out, or deciding whether a package already subscribes to a topic.

## `email.message.received`

Stored inbound email dispatches `email.message.received` after Kody stores the
message and attachment metadata.

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

Do not expect parsed bodies or attachment bytes in the event. Fetch full message
bodies, parsed headers beyond the event metadata, or attachment bytes only when
the handler needs them with `email_message_get`, `email_attachment_get`, or the
package runtime `email` helper.

## `email.message.delivery.updated`

Outbound Email Sending lifecycle changes dispatch
`email.message.delivery.updated`. The payload contains metadata for the owned
Kody message plus the provider event id, delivery status, terminal flag,
recipient, SMTP delivery fields, optional bounce/failure/rejection/complaint
details, and provider event timestamp.

Use this topic for delivery notifications and bounce or complaint workflows. Do
not resend on `deferred`: Cloudflare still has provider retries pending.
Provider event ids are stored idempotently, so duplicate Queue delivery does not
dispatch duplicate package invocations. Out-of-order events remain available in
delivery history but do not dispatch after a newer status.

## `email.system-message.received` (admins)

Mail stored in the operator-owned system inbox (`kody@<apex>`, `support@<apex>`,
and the other reserved system locals) dispatches `email.system-message.received`
to packages saved by users who hold the admin role at dispatch time. Non-admin
subscribers never receive system mail.

The payload matches `email.message.received` (with
`event: 'email.system-message.received'`) plus an `admin_url` string linking to
the stored message in the admin interface (`/admin/system-email?messageId=...`).
Handlers run as the admin package owner, so the user-scoped email capabilities
and the `email` runtime helper cannot read the system message — use the metadata
and `admin_url` for notifications, and the admin `admin_system_email_get`
capability for full contents.

## `platform.feedback.submitted` (admins)

A successful, consent-gated `meta_platform_feedback_submit` insert enqueues a
durable `platform.feedback.submitted` attempt. The Queue consumer dispatches to
packages saved by users who hold the admin role when the message is processed. A
non-admin package may declare the topic, but it never receives the event. Admin
roles are read fresh for every attempt, so revocation stops delivery on the next
processed submission.

Handlers receive this opaque metadata payload:

```ts
type PlatformFeedbackSubmittedEvent = {
	event: 'platform.feedback.submitted'
	feedback: {
		id: string
		category: 'friction' | 'bug' | 'experience' | 'suggestion' | 'other'
		status: 'open'
		created_at: string
	}
}
```

The event intentionally omits submitter identity and every user-authored field,
including summary and details. It also omits content warnings, admin notes,
reviewer fields, and an admin URL. Notification handlers should send only the
feedback id, category, and creation time. A human admin can later review the
approved submission with `admin_platform_feedback_get`; no user-authored text or
submitter identity should enter package invocation parameters or Discord.

The feedback row is durable before Kody awaits the small Queue enqueue. Enqueue
failure is logged but does not change the successful MCP response, avoiding a
duplicate submission when a client retries. Queue delivery retries transient
load, discovery, or package-invocation wrapper infrastructure failures before
eventually routing exhausted messages to the DLQ. The same idempotency key makes
redelivery safe, but a stored failed invocation replays rather than
automatically rerunning; the DLQ is the recovery surface. Terminal handler
execution failures are isolated without preventing attempts for sibling
subscribers.
