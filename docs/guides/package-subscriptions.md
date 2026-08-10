---
id: package_subscriptions
title: Package subscription guide
summary:
  Use package.json#kody.subscriptions for package-owned event handlers; discover
  subscribers with package_subscriptions_list; smoke-test handlers with
  package_subscription_dispatch; follow metadata-first email, run.error.recorded
  activity notifiers, plus consent-gated admin-only platform.feedback.submitted
  notification guidance.
category: platform
---

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

## Synthetic dispatch

`package_subscription_dispatch` invokes **one** subscription handler on **one**
saved package over MCP. It is a platform-marked real-surface run with real side
effects. Use it immediately after publish to verify handler wiring without
waiting for production fan-out.

```json
{
	"kody_id": "email-automation",
	"package_scope": "kody",
	"topic": "email.message.received",
	"params": {}
}
```

For stored inbound mail, replay with `email_message_id` instead of `params`:

```json
{
	"kody_id": "email-automation",
	"package_scope": "kody",
	"topic": "email.message.received",
	"email_message_id": "00000000000000000000000000000001"
}
```

Pass exactly one of `params` or `email_message_id`. There is no caller
`idempotency_key` — the platform generates internal idempotency keys.

Final `published` and `already_published` results from
`package_publish_external_push` include `test_hints.subscriptions[]` with a
starter snippet per declared topic when subscriptions are present. For a
`dispatched` result, poll the workflow to completion before reading its final
publish result. Failed and non-fast-forward results have no test hints.

### Handler guidance

- **Platform markers.** The platform sets top-level `synthetic: true` and, for
  stored-mail replay, `replay_of`. Real event dispatch strips caller-supplied
  `synthetic` and `replay_of` from handler envelopes. Run records agree with the
  handler payload.
- **`params` or `email_message_id`.** Fixture `params` merge into the handler
  envelope before markers are added. `email_message_id` rebuilds the stored
  inbound email envelope from D1.
- **Treat synthetic identically to production.** Handlers run the same code path
  unless a deliberately visible irreversible-side-effect guard says otherwise.
- **Start minimal.** Begin with `{}` or the smallest object your handler
  accepts, then add fields until the smoke test covers the branches you care
  about.
- **Filters are not applied.** Production dispatch for package-emitted topics
  skips subscribers when `filters` do not match the payload; synthetic dispatch
  always runs the named package. Put filter-matching fields inside `params` when
  testing filter-dependent code paths.
- **Admin-only topics** (`email.system-message.received`,
  `platform.feedback.submitted`, `community.activity.recorded`) gate
  **production** fan-out on admin role; synthetic dispatch still runs your
  handler directly for smoke testing.
- **Activity.** Synthetic runs appear on the `subscription` surface. Handler
  failures do not emit `run.error.recorded` (recursion guard).

Full call semantics and examples:
[Synthetic event dispatch](../use/synthetic-event-dispatch.md).

## Package-emitted topics (`@scope/...`)

Packages can define their own event topics and emit to them; every other package
saved by the same user that declares the topic in `kody.subscriptions` receives
the event. There is no cross-user delivery.

### Declaring emitted topics

Declare topics in `package.json#kody.emits`. Topics must use the scoped form
`@{username}/topic.name` with a lower-dot-case body, and the scope must match
the emitting package's npm scope:

```json
{
	"name": "@kentcdodds/discord-gateway",
	"kody": {
		"id": "discord-gateway",
		"description": "Discord gateway.",
		"emits": {
			"@kentcdodds/discord.message.created": {
				"description": "A Discord message was created.",
				"payloadSchema": {
					"type": "object",
					"properties": {
						"messageId": { "type": "string", "minLength": 1 },
						"channelId": { "type": "string" }
					},
					"required": ["messageId", "channelId"],
					"additionalProperties": false
				}
			}
		}
	}
}
```

`payloadSchema` is optional. When present it must be a JSON Schema subset with
root `"type": "object"`; supported keywords are `type`, `description`,
`properties`, `required`, `additionalProperties` (boolean), `items`, `enum`,
`const`, `minLength`, `maxLength`, `minimum`, `maximum`, `minItems`, and
`maxItems`. Unsupported keywords fail package checks at publish time so authors
never rely on silently ignored constraints. Declared schemas appear in package
search/detail projections so subscribers can discover payload shapes.

### Emitting

Emit from any package runtime context (exports, subscription handlers,
package-owned jobs, services, apps, retrievers) with the `events` helper:

```ts
import { events } from 'kody:runtime'

await events.dispatch({
	topic: '@kentcdodds/discord.message.created',
	idempotencyKey: `discord:message-create:${message.id}`,
	payload: { messageId: message.id, channelId: message.channelId },
})
```

Rules:

- The topic must be declared in the emitting package's `kody.emits`.
- `idempotencyKey` is required; payloads must be JSON objects and are validated
  against `payloadSchema` when declared.
- Payloads are capped at 64 KiB (canonical JSON). Store large data with
  `packageStorage()` and emit a reference instead.
- `events.dispatch` is unavailable in ad hoc `execute` runs — topics belong to
  packages, so emit from package code (or `packages.invoke` into one).

### Delivery semantics

Dispatch is asynchronous and durable: `events.dispatch` validates the event,
enqueues it on the `kody-package-events-dispatch` Queue (with DLQ), and returns
`{ topic, source, idempotencyKey, status: "enqueued" }` immediately. Emitters
never observe subscriber results or latency; check each subscriber's run records
for handler outcomes.

The Queue consumer resolves the emitting user's subscribed packages at delivery
time and invokes each `subscription:@scope/topic` handler with:

```ts
type PackageEventEnvelope = {
	event: string
	source: { type: 'package'; package_id: string; kody_id: string }
	idempotency_key: string
	payload: Record<string, unknown>
}
```

- Per-subscriber invocations are exactly-once keyed on
  `(source package, subscriber package, topic, idempotencyKey)`, so Queue
  redelivery replays stored results instead of re-running handlers.
- Infrastructure failures before handler code runs retry via the Queue (3
  attempts, then the `kody-package-events-dispatch-dlq` dead-letter queue).
  Terminal handler failures do not retry — a stored failed invocation replays
  rather than re-running — and stay visible in run records.
- Event-driven chains carry the same nested invocation depth budget as
  `packages.invoke` (max 8 hops), so emit cycles between packages terminate.
- In environments without the Queue binding (local dev, preview) — or when an
  enqueue fails — dispatch falls back to inline delivery with the same consumer
  code path and reports `status: "delivered_inline"` instead of `"enqueued"`.

### Filters on package-emitted topics

A subscription to a package-emitted topic may declare `filters`; every filter
key must be present in the event payload with an equal JSON value or the
subscriber is skipped:

```json
{
	"kody": {
		"subscriptions": {
			"@kentcdodds/discord.message.created": {
				"handler": "./src/on-general-chat-message.ts",
				"filters": { "channelId": "1470913684598423592" }
			}
		}
	}
}
```

Platform-owned topics (below) keep their existing behavior: their dispatchers
define whether and how `filters` apply.

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

## `repo.pushed`

When Cloudflare Artifacts reports commits pushed to a Kody-managed Artifacts
repo (plain repo, package, or job source), Kody dispatches `repo.pushed` to
packages saved by that same user that declare the topic. Delivery is durable via
the `kody-artifacts-repo-events` Queue (with DLQ). Session fork repos never
emit. Events for other `ARTIFACTS_NAMESPACE` values are ignored.

Handlers receive a metadata-first payload:

```ts
type RepoPushedEvent = {
	event: 'repo.pushed'
	repo: {
		source_id: string
		repo_id: string
		entity_kind: 'repo' | 'package' | 'job'
		entity_id: string
		name: string | null
		kody_id: string | null
	}
	push: {
		ref: string
		before: string
		after: string
		total_commits_count: number
		commits_truncated: boolean
		commits: Array<{
			id: string
			message: string
			message_truncated: boolean
			timestamp: string
			author: { name: string; email: string }
			committer: { name: string; email: string }
			parents: Array<string>
		}>
	}
	artifacts: {
		namespace: string
		event_timestamp: string
		event_subscription_id: string
	}
}
```

`repo_id` is the Artifacts repo name (also stored on `entity_sources.repo_id`).
`name` is the user-facing plain-repo name or package npm name when known;
`kody_id` is set for packages. For `entity_kind: 'package' | 'job'`, a push
updates live HEAD but does not mean the package/job published commit advanced —
use publish / external-push / reconcile for activation.

Idempotency keys include the after commit, ref, and subscriber package id, so
Queue redelivery is safe.

## `repo.created` / `repo.deleted`

Account-level Artifacts create/delete events map to `repo.created` and
`repo.deleted` with the same `repo` entity block plus Artifacts metadata
(`default_branch`, `description`, Cloudflare `cloudflare_repo_id`). Same-user
fan-out and Queue delivery match `repo.pushed`. Unmatched deletes (D1 row
already gone) are acknowledged without retry.

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
