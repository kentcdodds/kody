# Synthetic event dispatch

`package_subscription_dispatch` invokes a **single** subscription handler on a
saved package over MCP. It is a **platform-marked real-surface** `subscription`
run through the normal package execution path (`packageStorage()`, secrets,
`kody:runtime`). **Side effects are real.**

Use it to verify `package.json#kody.subscriptions` wiring immediately after
publish. It targets only the package you name; it does not fan out to other
subscribers and does not enqueue production Queue delivery.

The platform sets top-level envelope fields `synthetic: true` and, for
stored-mail replay, `replay_of`. Real event dispatch strips caller-supplied
`synthetic` and `replay_of` from handler envelopes; callers cannot forge those
fields on synthetic MCP calls either. Run records agree with the handler
payload. Handlers treat synthetic events identically to production unless a
deliberately visible irreversible-side-effect guard says otherwise.

## When to use it

- After `package_publish_external_push` when the package declares subscriptions
  and `test_hints` includes topic snippets
- To debug handler logic with a minimal fixture payload
- To replay a stored inbound message with `email_message_id`
- Together with [Package app fetch](./package-app-fetch.md) as part of
  post-publish verification

Use `package_subscriptions_list` first to confirm the topic and handler path.
Use real platform events for end-to-end delivery, admin-role gates, filters, and
multi-package fan-out.

## Call shape

Search the `packages` domain, then call `package_subscription_dispatch`:

```json
{
	"kody_id": "email-automation",
	"topic": "email.message.received",
	"params": {}
}
```

Fields:

| Field              | Required | Meaning                                                                 |
| ------------------ | -------- | ----------------------------------------------------------------------- |
| `kody_id`          | yes      | Bare `kody.id` of the package whose handler should run                  |
| `package_scope`    | no       | Owner scope for delegated packages; preserve it from publish test hints |
| `topic`            | yes      | Exact topic key from `kody.subscriptions`                               |
| `params`           | one of   | Handler input fixture — use `{}` only when the handler tolerates empty  |
| `email_message_id` | one of   | Stored inbound message id; platform rebuilds the production envelope    |

Pass exactly **one** of `params` or `email_message_id`, not both. There is no
top-level request `idempotency_key` — the platform generates it. A
package-emitted event fixture can still include its production
`params.idempotency_key` inside the nested event envelope.

Pass the bare `kody.id`, not the npm-scoped package name. Preserve
`package_scope` when it appears in a publish test hint so dispatch resolves the
intended owner-scoped package.

### Fixture input (`params`)

`params` is the object merged into the handler envelope (before the platform
adds `synthetic: true`). Shape depends on the topic:

- **Platform-owned topics** (`email.message.received`, `run.error.recorded`,
  `repo.pushed`, …) — use the metadata-first payloads documented in the
  [package subscriptions guide](../guides/package-subscriptions.md). Include
  only fields your handler reads.
- **Package-emitted topics** (`@scope/topic.name`) — use the
  `PackageEventEnvelope` shape (`event`, `source`, `idempotency_key`,
  `payload`). Synthetic dispatch does not validate against the emitter's
  `kody.emits` schema; supply a fixture `source` block when the handler depends
  on it.

Example minimal `run.error.recorded` fixture:

```json
{
	"kody_id": "failure-notifier",
	"topic": "run.error.recorded",
	"params": {
		"event": "run.error.recorded",
		"run": {
			"id": "00000000000000000000000000000001",
			"surface": "job",
			"name": "smoke",
			"package_id": null,
			"kody_id": null,
			"source_id": null,
			"published_commit": null,
			"storage_id": null,
			"job_id": null,
			"workflow_id": null,
			"invocation_id": null,
			"session_id": null,
			"parent_run_id": null,
			"started_at": "2026-08-08T12:00:00.000Z",
			"finished_at": "2026-08-08T12:00:01.000Z",
			"duration_ms": 1000,
			"error_name": "Error",
			"error_message": "Synthetic smoke failure"
		},
		"activity_url": "https://heykody.app/account/activity/00000000000000000000000000000001"
	}
}
```

### Stored-mail replay (`email_message_id`)

For email topics, pass a stored message id instead of hand-building metadata:

```json
{
	"kody_id": "email-automation",
	"topic": "email.message.received",
	"email_message_id": "00000000000000000000000000000001"
}
```

The platform rebuilds the stored inbound email envelope from D1, sets
`synthetic: true`, and sets `replay_of` to the message id. The handler sees the
same shape as production dispatch for that message.

## Response and Activity

Successful invocations return the handler's JSON-serializable result (when the
handler returns one). Handler throws and non-2xx infrastructure failures surface
as structured MCP errors. Check [Activity](./activity.md) (`subscription`
surface) for run records; the run record includes `synthetic: true` (and
`replay_of` when applicable). Subscription-handler failures do **not** emit
`run.error.recorded` (recursion guard).

## Semantics

- Requires a published subscription handler bundle for the topic.
- Ignores subscription `filters` — synthetic dispatch always targets the named
  package; supply matching fields inside `params` when testing filter-dependent
  logic.
- Admin-only delivery rules (for example `platform.feedback.submitted`) apply to
  **production** fan-out only; synthetic dispatch runs your handler directly for
  smoke testing.
- Side effects (`packageStorage()`, outbound APIs, downstream invokes) are real.
  Use a deliberately visible irreversible-side-effect guard when smoke tests
  should stay safe.

## Related

- [Packages](./packages.md) — subscription manifest shape
- [Package app fetch](./package-app-fetch.md) — app handler smoke tests
- [Package subscriptions guide](../guides/package-subscriptions.md) — topic
  payloads and production delivery semantics
- [Package authoring guide](../guides/package-authoring.md#verify-your-publish)
- Decision:
  [Synthetic package requests](../contributing/decisions/0013-synthetic-package-requests.md)
