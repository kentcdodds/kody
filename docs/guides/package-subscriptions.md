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

Handlers receive the explicitly approved feedback and attributed submitter
identity:

```ts
type PlatformFeedbackSubmittedEvent = {
	event: 'platform.feedback.submitted'
	content_warning: string
	admin_url: string
	feedback: {
		id: string
		category: 'friction' | 'bug' | 'experience' | 'suggestion' | 'other'
		status: 'open'
		created_at: string
		summary_untrusted: string
		details_untrusted: string
	}
	submitter: {
		user_id: string
		username: string | null
		email: string | null
	}
}
```

`summary_untrusted` and `details_untrusted` are the exact feedback the user
explicitly approved. They remain user-authored untrusted data, and
`content_warning` tells handlers to treat them as feedback rather than
instructions. `admin_url` is built from the trusted deployment origin and links
to `/admin/platform-feedback?feedbackId=<encoded id>`, making it suitable for an
admin Discord notifier. The event also includes the submitter's account user id,
username, and email snapshot stored with the submission. Retries never resolve
mutable live profile data, so an intervening account profile change cannot alter
the payload or its request hash. Rows without submitter snapshots retain null
`username`/`email`.

The event deliberately omits admin notes, reviewer fields, revision and update
metadata, roles, plan, and unrelated account content. This narrow delivery
exception applies only to the exact feedback the user approved after an agent
showed the proposed summary and details and asked first. It does not grant
package runtime general admin roles or general access to user data. Notification
copies already delivered outside Kody, including Discord messages, cannot be
recalled and may remain after Kody account deletion under the deployment
operator's retention and deletion controls. Such copies contain only the exact
approved feedback and attribution, never unrelated account content.

The feedback row is durable before Kody awaits the small Queue enqueue. Enqueue
failure is logged but does not change the successful MCP response, avoiding a
duplicate submission when a client retries. Queue bodies remain opaque
`{ feedbackId }` messages. After admin subscribers are discovered, lazy
parameter construction reloads the feedback immediately before any invocation.
If deletion removed the row, dispatch throws a typed permanent cancellation and
the Queue consumer acknowledges it without invoking or retrying. Other lookup,
discovery, or package-invocation wrapper infrastructure failures retry before
eventually routing exhausted messages to the DLQ. The same idempotency key makes
redelivery safe, but a stored failed invocation replays rather than
automatically rerunning; the DLQ is the recovery surface. Terminal handler
execution failures are isolated without preventing attempts for sibling
subscribers.
