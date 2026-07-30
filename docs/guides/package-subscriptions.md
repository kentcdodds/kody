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

Accepted stored inbound email dispatches `email.message.received` after Kody
stores the message and attachment metadata. Quarantined mail uses
`email.message.quarantined` instead.

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

## `email.message.quarantined`

Quarantined stored inbound email dispatches `email.message.quarantined` instead
of `email.message.received`. The payload matches `email.message.received` with
`event: 'email.message.quarantined'`. Reclassifying a message later does not
retroactively dispatch either topic.

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

Accepted mail stored in the operator-owned system inbox (`kody@<apex>`,
`support@<apex>`, and the other reserved system locals) dispatches
`email.system-message.received` to packages saved by users who hold the admin
role at dispatch time. Quarantined system-inbox mail is stored but never
dispatched. Non-admin subscribers never receive system mail.

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
admin notifier. The event also includes the submitter's account user id,
username, and email snapshot stored with the submission. Retries never resolve
mutable live profile data, so an intervening account profile change cannot alter
the payload or its request hash. Rows without submitter snapshots retain null
`username`/`email`.

The event deliberately omits admin notes, reviewer fields, revision and update
metadata, roles, plan, and unrelated account content. This narrow delivery
exception applies only to the exact feedback the user approved after an agent
showed the proposed summary and details and asked first. It does not grant
package runtime general admin roles or general access to user data. Notification
copies already delivered outside Kody cannot be recalled and may remain after
Kody account deletion under the deployment operator's retention and deletion
controls. Such copies contain only the exact approved feedback and attribution,
never unrelated account content.

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

## `run.error.recorded`

When a user-scoped Activity / run record finishes with `status: 'error'`, Kody
dispatches `run.error.recorded` to packages saved by that same user that declare
the topic. Delivery is best-effort after a successful run-record Durable Object
write — there is no Queue / DLQ for this topic in v1. Failures during subscriber
discovery or package-invocation infrastructure are logged and do not fail the
observed run.

Handlers receive a metadata-first payload:

```ts
type RunErrorRecordedEvent = {
	event: 'run.error.recorded'
	run: {
		id: string
		surface: string
		name: string | null
		package_id: string | null
		kody_id: string | null
		source_id: string | null
		published_commit: string | null
		storage_id: string | null
		job_id: string | null
		workflow_id: string | null
		invocation_id: string | null
		session_id: string | null
		parent_run_id: string | null
		started_at: string
		finished_at: string | null
		duration_ms: number | null
		error_name: string | null
		error_message: string | null
	}
	activity_url: string
}
```

`activity_url` is built from the trusted deployment origin and links to
`/account/activity/<runId>`. The event deliberately omits log lines and the full
run `metadata` blob — fetch detail with `run_get` when needed. Error name and
message use the same truncation budget as the stored run record.

Recursion guard: runs whose surface is `subscription` never emit this event.
Subscription-handler failures themselves create run records; emitting again
would recurse. Successful runs and `execute` successes (which are not persisted)
never emit. Failed `execute` calls do persist and do emit.

Use this topic for notifier packages that email, write to Sheets, spawn an
agent, or otherwise react when something in the user's account fails.

## `package.codemod.applied`

After a successful package codemod **apply**, Kody dispatches
`package.codemod.applied` to packages saved by the **owning user** of the
migrated package that declare the topic. Delivery follows the same best-effort
host dispatch path as `run.error.recorded` — there is no Queue / DLQ for this
topic. Failures during subscriber discovery or package-invocation infrastructure
are logged and do not fail the codemod apply.

Handlers receive a metadata-first payload:

```ts
type PackageCodemodSubscriptionEnvelope = {
	event: 'package.codemod.applied'
	codemod: {
		id: string
		description: string
	}
	package: {
		package_id: string
		kody_id: string
	}
	run: {
		run_id: string
		item_id: string
	}
	changed_paths: Array<string>
	before_commit: string | null
	after_commit: string | null
}
```

`changed_paths` lists published-tree paths the codemod transform modified.
`before_commit` and `after_commit` are the package's published commit before and
after apply. The event deliberately omits file contents — fetch the current
published source with repo or package capabilities when a handler needs diffs or
full files. Community listing snapshots are unchanged by apply; only the owning
saved package advances. `run.item_id` is the apply ledger item id.

Use this topic for notifier packages that record migrations, ping owners, or
trigger follow-up automation when platform codemods rewrite user package source.

## `package.codemod.reverted`

After a successful package codemod **revert**, Kody dispatches
`package.codemod.reverted` to packages saved by the **owning user** of the
restored package that declare the topic. Delivery semantics match
`package.codemod.applied` and `run.error.recorded`.

Handlers receive the same envelope shape with
`event: 'package.codemod.reverted'`:

```ts
type PackageCodemodSubscriptionEnvelope = {
	event: 'package.codemod.reverted'
	codemod: {
		id: string
		description: string
	}
	package: {
		package_id: string
		kody_id: string
	}
	run: {
		run_id: string
		item_id: string
	}
	changed_paths: Array<string>
	before_commit: string | null
	after_commit: string | null
}
```

For revert, `before_commit` is the post-codemod published commit (the source
apply item's `afterCommit`) and `after_commit` is the restored pre-codemod
commit. `changed_paths` is copied from the source apply item (paths the codemod
originally changed), not recomputed at revert time. `run.item_id` is the new
revert-run ledger item id. Revert snapshots expire from KV after 90 days, so
revert and this event are unavailable once the snapshot is gone.

Use this topic when automation must react to an operator or user undoing a prior
codemod apply.

## `community.activity.recorded` (admins)

Successful community fork and rating writes enqueue a durable
`community.activity.recorded` attempt. The Queue consumer dispatches only to
packages saved by users who hold the admin role when the message is processed.
Non-admin declarations are inert, and role revocation applies to the next
attempt.

Handlers receive activity metadata only:

```ts
type CommunityActivityRecordedEvent = {
	event: 'community.activity.recorded'
	event_id: string
	activity:
		| {
				id: string
				kind: 'fork'
				listing: { id: string; name: string; kody_id: string }
				actor: { username: string | null }
				occurred_at: string
		  }
		| {
				id: string
				kind: 'rating'
				listing: { id: string; name: string; kody_id: string }
				actor: { username: string | null }
				occurred_at: string
				stars: number
				adaptation_effort: number
		  }
}
```

The event omits stable user ids, email, forked package/source ids, target kody
ids, rating notes, package source, secrets, and unrelated account content.
One-click installs and ordinary forks both appear as `fork` because they share
the same existing `community_forks` row shape. Rating records are upserts, so
the reloaded activity contains the latest scores.

Queue messages contain only `{ eventId, kind, activityId }`. Dispatch reloads
the metadata projection after admin subscriber discovery. Missing activity is a
permanent cancellation; transient lookup, discovery, and package-invocation
infrastructure failures retry and can reach the dedicated DLQ. `event_id`
provides a distinct package-invocation idempotency key for every recorded write.
