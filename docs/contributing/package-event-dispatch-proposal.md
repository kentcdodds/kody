# Package event dispatch proposal

This is an exploration note for package-dispatched events. It reviews the
current subscription and gateway-shaped invocation paths, then proposes a small
runtime primitive that lets package code dispatch an event to other saved
packages owned by the same user.

## Recommendation

Keep the current generic topic model for subscriber declarations, and add a
first-class package event dispatch primitive for producers.

`package.json#kody.subscriptions` is already generic enough for subscribers:
topics are strings, handlers are package-local modules, subscription bundle
artifacts use the topic, and `package_subscription_list` can discover same-user
subscribers by exact topic. What is missing is the producer side. Only
Kody-owned inbound email dispatches subscriptions today, so package-owned
gateway packages still have to own subscriber discovery and fan-out by calling
`packages.invokeChecked` themselves.

The recommended first producer surface is a package runtime helper:

```ts
import { events } from 'kody:runtime'

await events.dispatch({
	topic: 'discord.message.created',
	idempotencyKey: `discord:message-create:${message.id}`,
	payload: {
		messageId: message.id,
		channelId: message.channel_id,
		guildId: message.guild_id,
		authorId: message.author.id,
	},
})
```

The helper should be available only in package runtime contexts at first. The
existing external package invocation API can remain the ingress path for a
trusted gateway process; that invoked gateway export can then call
`events.dispatch(...)` inside Kody. A separate external event-dispatch HTTP
endpoint or MCP capability can come later after the token and replay semantics
are proven.

## Current behavior reviewed

- Manifest subscriptions are declared under `package.json#kody.subscriptions` as
  a record of topic to `{ handler, description?, filters? }` in
  `packages/worker/src/package-registry/types.ts`.
- `listPackageSubscriptions(...)` in
  `packages/worker/src/package-registry/manifest.ts` normalizes handler paths
  and returns topic, handler, description, and filters sorted by topic.
- `package_subscription_list` in
  `packages/worker/src/mcp/capabilities/packages/list-package-subscriptions.ts`
  is a read-only MCP discovery capability. It loads the signed-in user's saved
  packages, loads manifests, and optionally filters by exact topic.
- Subscription artifact names are `subscription:${topic}` via
  `buildPackageSubscriptionArtifactName(...)` in
  `packages/worker/src/package-runtime/subscription-artifacts.ts`.
- `resolvePackageModuleResolution(...)` in
  `packages/worker/src/package-invocations/service.ts` resolves subscription
  handlers from the manifest and the subscription artifact name.
- `invokePackageSubscription(...)` in
  `packages/worker/src/package-invocations/service.ts` invokes a subscription
  handler through the same package invocation runtime as exports, with surface
  `subscription`, topic metadata, package storage, package context, and runtime
  debug logs.
- Package invocation idempotency is persisted in
  `packages/worker/migrations/0029-package-invocations.sql` by user, token,
  package, export name, and idempotency key. Subscription invocations currently
  store `export_name` as `subscription:${topic}`.
- The only production dispatcher is inbound email:
  `dispatchInboundEmailSubscriptionEvents(...)` in
  `packages/worker/src/email/package-subscriptions.ts` finds same-user
  subscribers for `email.message.received`, builds a metadata-first payload, and
  invokes each subscription.
- The Discord gateway-style path is documented in
  `docs/contributing/package-invocation-api.md`: a trusted external process owns
  a long-lived gateway connection and POSTs one saved package export. Current
  docs in `docs/use/packages.md` and
  `docs/contributing/packages-and-manifests.md` recommend
  `packages.invokeChecked` for runtime fan-out from that gateway package.

## Why the current model is not quite enough

The intentionally generic topic model is enough for declaration, discovery, and
handler bundling. It is not enough for dispatch because there is no platform
primitive that says "deliver this package-owned event to all subscribers for
this topic."

Without such a primitive, each gateway-style package has to decide:

- how to discover subscribers or maintain a subscriber list
- which export names subscriber packages should expose
- how to derive idempotency keys per subscriber
- how to represent source and topic metadata in logs
- how to handle partial fan-out failures
- how to avoid package-to-package loops

Kody already solved most of this for inbound email. A package-dispatched event
primitive can reuse that machinery and make gateway packages smaller: the
external gateway invokes one package export, and that export asks Kody to fan
out to manifest-declared subscribers.

## Proposed runtime API

Add `events` to `kody:runtime` in package runtime contexts:

```ts
type PackageEventDispatchInput = {
	topic: string
	idempotencyKey: string
	payload?: Record<string, unknown>
	source?: string
}

type PackageEventDispatchResult = {
	topic: string
	source: {
		type: 'package'
		packageId: string
		kodyId: string
	}
	idempotencyKey: string
	subscribers: Array<{
		packageId: string
		kodyId: string
		handler: string
		status: 'completed' | 'failed' | 'replayed'
		error?: {
			code: string
			message: string
		}
	}>
	delivered: number
	failed: number
}

declare const events: {
	dispatch(
		input: PackageEventDispatchInput,
	): Promise<PackageEventDispatchResult>
} | null
```

`events.dispatch` should require:

- an authenticated user in the caller context
- a package runtime context so the source package identity is host-derived, not
  user-provided
- a non-empty exact topic
- an explicit non-empty idempotency key
- a JSON object payload when payload is present

The dispatched handler payload should be an envelope for package-dispatched
events:

```ts
type PackageDispatchedEventEnvelope = {
	event: string
	source: {
		type: 'package'
		package_id: string
		kody_id: string
	}
	idempotency_key: string
	payload: Record<string, unknown>
	dispatched_at: string
}
```

Keep existing Kody-owned payloads such as `email.message.received` unchanged.
Package-dispatched events can use the envelope because no compatibility promise
exists yet for custom topics.

## Subscriber discovery and topics

Discovery should reuse the same manifest/repository functions behind
`package_subscription_list`, not call the MCP capability internally:

1. read the current runtime user id
2. list saved packages for that user only
3. load each package manifest with that same user id
4. match `package.json#kody.subscriptions` by exact normalized topic
5. invoke the matching subscription handler for each saved package

Initial matching should be exact topic only. `filters` should remain visible
metadata but should not get generic platform semantics yet. Generic filter
matching will become a compatibility contract quickly, and different topics want
different filter shapes. For `discord.message.created`, subscribers can check
`channelId`, `guildId`, or other event metadata in their handler. If filtering
becomes important for scale, add topic-owned filter schemas and dispatchers
later.

Topic conventions should be documented before broad use:

- Kody-owned built-in topics such as `email.message.received` are reserved.
  Package code should not be allowed to spoof built-in sources.
- Package/custom topics should be lower-dot-case, such as
  `discord.message.created` or `package.<source-kody-id>.event-name`.
- Subscribers must treat the host-provided `source` identity as the authority
  for who emitted the event. A topic name alone is not proof that an external
  provider produced the event.

An optional future `package.json#kody.emits` allowlist could make topic
ownership and package intent reviewable, but it is not required for a narrow
first implementation.

## Payload, idempotency, and replay

Payloads should be metadata-first:

- JSON object only
- small routing and lookup metadata
- no OAuth tokens, API keys, raw message bodies, attachment bytes, or large
  provider payloads
- use package storage, package secrets, MCP capabilities, or provider APIs for
  full details on demand

The dispatch input should require an explicit idempotency key. The service can
derive each subscriber invocation key from:

- source package id
- topic
- dispatch idempotency key
- subscriber package id

For example:

```text
pkgevent:<sourcePackageId>:<subscriberPackageId>:<topic>:<hash(idempotencyKey)>
```

Each subscription invocation should still use the existing `package_invocations`
table for per-handler idempotency and replay. Repeated dispatches with the same
source package, topic, idempotency key, and payload should replay
already-completed subscriber invocations and should fail with the existing
idempotency mismatch behavior if the payload changes.

There are two viable replay contracts:

1. **Direct fan-out contract:** resolve the current subscriber set on each
   dispatch. Replays can deliver to subscribers added after the original event,
   while existing subscribers replay their stored response. This is the smallest
   implementation and matches dynamic package discovery.
2. **Dispatch ledger contract:** add a `package_event_dispatches` table keyed by
   user, source package, topic, and idempotency key. Store the request hash and
   resolved subscriber package ids from the first dispatch, then replay the same
   subscriber set on retries.

Start with direct fan-out only if the product is comfortable with the "current
subscriber set" replay semantics. If package events become an external-facing
ingress primitive, add the dispatch ledger before exposing that surface.

Nested dispatch should reuse the package runtime invocation depth guard already
used by `packages.invoke`. `events.dispatch` should increment the same depth
when invoking subscription handlers so package A -> event -> package B -> event
loops stop at the configured runtime depth limit.

## Security and isolation

Every lookup must be scoped by `userId`. A package-dispatched event must never
discover or invoke another user's packages.

The source package should not receive any subscriber package secrets, storage,
or code. The subscriber handler runs with its own package runtime context,
package-owned storage id, package secrets, and normal capability rules. The only
cross-package data is the event envelope.

The source identity should be host-derived from `packageContext`, not accepted
from the dispatch input. Allowing a free-form `source` label for logs is useful,
but logs and handler payloads should also include the canonical source package
id and `kody.id`.

This primitive does broaden what a source package can trigger. Today a package
can call another package export with `packages.invoke` if it knows the target.
Events add manifest-based discovery. That is acceptable because subscribers opt
in by declaring the topic, but built-in topics should remain reserved and topic
ownership should be documented clearly.

## Observability and failure behavior

Each subscriber invocation should continue to create a `package_invocations` row
and a package runtime debug run with:

- surface `subscription`
- name equal to the topic
- source `package:<sourceKodyId>`
- topic equal to the event topic
- metadata containing `sourcePackageId`, `sourceKodyId`, and, if present, a
  dispatch id

Existing `package_debug_list_runs` and `package_debug_get_run` can then show
subscription handler logs. `package_subscription_list` remains the discovery
tool when debugging why a topic has no subscribers.

`events.dispatch` should not throw just because one subscriber handler failed.
It should return a fan-out summary with per-subscriber statuses. It should throw
only for invalid dispatch input, missing runtime context, storage/manifest
lookup failures that prevent discovery, or depth-limit failures. This mirrors
email dispatch, where individual handler failures are captured as invocation
responses rather than breaking inbound email storage.

## Workflows

Direct package invocation is sufficient for the first package event primitive.
It reuses existing subscription artifacts, package invocation idempotency, and
runtime debug logs. It also lets a gateway export await fan-out and return a
structured summary to the external process.

Do not put every event fan-out through workflows initially. Workflows add a
durable retry and sleep model, but they also change latency, ordering, and
failure semantics. Handlers that need durable long-running follow-up work can
call `workflows.create(...)` themselves with a small payload.

If event volume or retry requirements outgrow direct fan-out, the same
`events.dispatch` contract can enqueue one workflow per subscriber later. That
change should preserve topic matching, payload envelope, source identity, and
idempotency derivation.

## Fly or Discord gateway migration path

There are no Fly-specific runtime files in this repository. The relevant gateway
behavior is the documented Discord Gateway pattern:

1. trusted external process owns the websocket
2. external process POSTs one gateway package export through the external
   package invocation API
3. gateway package currently fans out with `packages.invokeChecked`

With package events:

1. keep the external POST endpoint and bearer-token model unchanged
2. change the gateway export to normalize the provider event and call
   `events.dispatch({ topic, idempotencyKey, payload })`
3. move subscriber packages from agreed export names such as
   `./handle-discord-message-created` to
   `package.json#kody.subscriptions["discord.message.created"].handler`
4. keep legacy export fan-out and event dispatch side-by-side for a transition
   if existing packages depend on the old export shape
5. remove the manual subscriber list or hard-coded `packages.invokeChecked`
   calls once subscribers have declared manifest subscriptions

This simplifies the gateway package because it no longer owns subscriber
enumeration, handler artifact naming, per-subscriber idempotency, or partial
failure summary construction.

## Minimal implementation plan

1. Add a package event dispatch service, for example
   `packages/worker/src/package-events/dispatch.ts`, that performs same-user
   subscription discovery and direct fan-out.
2. Extend `invokePackageSubscription(...)` narrowly so non-email dispatchers can
   pass source package metadata, a package-event internal token id, and nested
   runtime depth. Preserve the current email defaults.
3. Add `PackageEventTools` beside `PackageInvokeTools` in
   `packages/worker/src/mcp/run-codemode-registry.ts`, expose an
   `events.dispatch` bridge, and export `events` from the virtual `kody:runtime`
   module in `packages/worker/src/package-runtime/module-graph.ts`.
4. Update repo check type declarations in `packages/worker/src/repo/checks.ts`
   so package authors get the `events` runtime type.
5. Add focused tests:
   - discovery is same-user only and exact-topic only
   - no-subscriber dispatch returns an empty successful summary
   - subscriber handlers are invoked with the envelope and source metadata
   - per-subscriber idempotency replays duplicate dispatches
   - a changed payload with the same idempotency key reports mismatch
   - subscriber failures appear in the summary without aborting other
     subscribers
   - nested package event dispatch observes the runtime depth limit
6. Document the runtime helper in `docs/use/packages.md` and link this proposal
   or replace it with settled behavior docs once implemented.

Do not remove or rewrite existing package subscription behavior. The first
implementation should be additive and should keep `email.message.received`
dispatch working through the current path until shared package event dispatch is
fully covered by tests.

## Open questions and risks

- Should the first implementation include a dispatch ledger, or is direct
  current-subscriber fan-out sufficient for gateway package use?
- Should package authors declare emitted topics in `package.json#kody.emits`
  before dispatching custom topics?
- Which topic namespaces should Kody reserve beyond current built-in topics?
- Should `filters` stay topic-specific metadata, or should Kody eventually
  define a small standard filter language?
- Should there be an external `POST /@:username/api/package-events/:topic`
  endpoint, or should trusted external gateways always invoke one package export
  first?
- Should `events.dispatch` be available from authenticated MCP `execute`, or
  only from package runtime contexts where source package identity is clear?
- If a subscriber is added after an event was first dispatched, should a retry
  with the same idempotency key deliver to that new subscriber? This is the main
  reason to consider a dispatch ledger.
