# Email primitives

Kody has a storage-first email surface for Cloudflare Email Service and Email
Routing. Every user gets an automatic inbox address at
`{username}@<platform domain>`, where the platform domain is the deployment's
user email domain: the `USER_EMAIL_DOMAIN` env var when set, otherwise `inbox.`
plus the hostname of `APP_BASE_URL` (for example `you@inbox.heykody.app`). Kody
receives routed mail for that address, stores parsed messages for later
automation, and can send notify-self mail and replies from the matching
platform-assigned sender address.

## Addressing model

- Inbound mail to `{username}@<platform domain>` routes to the user who owns
  that username. The default inbox is provisioned automatically at signup (or on
  the first inbound message), so there is nothing to create or configure.
- Subaddressing (RFC 5233 plus addressing) is supported: mail to
  `{username}+{tag}@<platform domain>` routes to `{username}`'s inbox (and
  `support+{tag}@<apex>` to the corresponding system inbox). The base local part
  — everything before the first `+` — is what routes, so a tag can never bypass
  the reserved or unknown-username checks. The full tagged address is preserved
  in the stored message's `to_addresses`, so a package subscribing to
  `email.message.received` can dispatch on the tag (for example, only handle
  mail addressed to `{username}+invoices@...`).
- Mail to unknown usernames is rejected, and the app's apex domain is never a
  user inbox: user mail lives exclusively on the configured platform domain (the
  `inbox.` subdomain by default), while the apex hosts only system mail — the
  transactional sender (`kody@<apex>`, used for verification and password-reset
  mail) and the operator-owned system inboxes (`kody`, `support`, `abuse`,
  `postmaster`, `security`, and `admin` at the apex route to Kody's system
  inbox, so replies to transactional mail land there). All other apex mail is
  rejected.
- Reserved local parts never route to a user inbox and can never be registered
  as usernames.
- User outbound mail always sends from `{username}@<platform domain>`. The from
  address is platform-assigned: a verified sender identity for it is provisioned
  automatically alongside the default inbox. There is no self-service sender
  registration or verification step.

## Capabilities

Use the MCP `email` domain:

- `email_inbox_list` lists inboxes and automatic platform addresses for the
  signed-in user.
- `email_send` sends a notification email to your own account email address
  (notify-self only; any other recipient is rejected).
- `email_reply` replies to a stored inbound message. The recipient always comes
  from the stored message. Optional `attachments` (up to 10 of
  `{ filename, content_type, content_base64 }`) are sent with the reply and
  stored as `external` attachments readable later via `email_attachment_get`.
  With attachments, the whole message (bodies plus decoded attachment bytes)
  must fit the plan's `email_message_bytes` per-message cap.
- `email_attachment_get` returns stored attachment bytes by attachment id.
- `email_message_list` lists stored inbound and outbound messages. Rows include
  `classification` and `classification_reason`; pass an optional
  `classification` filter (`accepted` or `quarantined`) to narrow the list.
- `email_message_search` searches stored messages by case-insensitive substring
  match against the subject, header `From`, and envelope sender. It accepts the
  same `inbox_id` / `direction` / `processing_status` / `delivery_status`
  filters and limit caps as `email_message_list`.
- `email_message_get` returns parsed bodies, headers, thread metadata, and
  attachment metadata.
- `email_message_classify` reclassifies a stored inbound message as `accepted`
  or `quarantined`. Reclassification never retroactively dispatches package
  subscription events.
- `email_sender_rule_list` lists sender allow/block/quarantine rules.
- `email_sender_rule_set` creates or updates a sender rule by address or domain
  (`kind` / `value` / `effect` / optional `note`).
- `email_sender_rule_delete` deletes one sender rule by id. Each user may store
  at most 200 sender rules.
- `email_delivery_event_list` lists stored delivery history, including final
  Email Sending outcomes, SMTP responses, bounces, rejections, and complaints.
- `email_usage_get` returns the signed-in user's email usage and limits: stored
  message count, today's send and receive counts, the applicable caps, and the
  plan name.

## Quotas

Inbound storage is quota-gated per user:

- A per-message raw-size cap (`email_message_bytes`), a daily receive limit
  (`email_receives_per_day`), and a stored-message cap (`stored_email_messages`)
  apply at storage time. Mail over any of these is rejected at the routing layer
  with a generic "over quota" response to the sender, and the detailed reason is
  recorded as a `rejected` delivery event. Oversize mail is rejected before it
  consumes any daily receive quota, and mail to unverified accounts (which can
  never receive) is rejected without consuming any quota at all. Transient
  storage failures (for example an R2 outage while saving raw MIME) do not keep
  the daily receive charge — the attempt is refunded so delivery retries are not
  blocked by quota.
- Plan users get their plan's limits. New accounts start on the `free` plan
  unless an invite assigns another tier. The operator-only `max` plan uses
  finite email caps (10,000 sends/day, 20,000 receives/day, 100,000 stored
  messages, 768 KiB per message); it is not a public or paid tier.
- Paid email caps are Standard: 200 sends/day, 1,000 receives/day, 10,000 stored
  messages; Pro: 500 sends/day, 2,000 receives/day, 25,000 stored messages. Both
  allow up to 768 KiB per message.
- Quota, size, and unverified-account rejections store at most five detailed
  `rejected` delivery events per inbox per UTC day; further rejections increment
  a single daily aggregate event (with a total count and the last reason) so
  rejected floods cannot grow storage. Parse-failure rejections keep one event
  per attempt — they are already bounded by the daily receive quota and the
  detail helps debug a misbehaving sender.
- Outbound sending stays limited by `email_sends_per_day` for plan users.
- Check where you stand with `email_usage_get`.

## Safety model

- Every email capability requires a **verified account email**. Until the
  account email is verified (via the link sent at signup, or a resend from the
  `/account` page), email capabilities are rejected, inbound mail routed to the
  account's platform address is rejected before storage, and MCP access as a
  whole is disabled.
- Any email routed to a verified user's platform address is stored, subject to
  the quotas above.
- Unknown usernames and reserved local parts outside the configured system
  address subset are rejected before storage. Configured system addresses are
  stored in the operator-owned system inbox and are visible only to admins.
- Display names are not trusted. Kody stores envelope sender, parsed `From`, and
  authentication headers separately.
- Outbound sending requires a verified account email, sends only from the
  platform-assigned address, and `email_send` only delivers to the signed-in
  user's own account email. `email_reply` is the only way to address external
  recipients, and only recipients taken from stored inbound mail.
- Outbound sends consume a per-day entitlement. The `max` plan allows 10,000
  send attempts per UTC day.
- A successful send request has `processing_status: "sent"`. Cloudflare delivery
  events independently populate `delivery_status` with `delivered`, `deferred`,
  `bounced`, `failed`, `rejected`, or `complained`; use
  `email_delivery_event_list` for the event history and SMTP details.
- Delivery events feed an automatic abuse pause: one spam complaint, or five or
  more bounced sends within a UTC day, pauses outbound sending for the account
  (receiving is unaffected). Every user sends from the same platform domain, so
  one account's complaints damage delivery for everyone. A paused send fails
  with a clear error; contact the operator to have the pause reviewed and
  cleared.
- System inbox mail is not gated by a user plan or account-verification state.
  It has fixed platform caps and retention: messages are pruned after 90 days
  and the stored system inbox is capped so arbitrary sender traffic cannot grow
  without bound.
- Stored inbound mail is the source of truth. If a user wants email automation,
  they can publish a package that subscribes to the stored inbound email topics
  `email.message.received` or `email.message.quarantined` using normal package
  subscriptions. This is package behavior, not a separate Kody-owned email
  handler or agent-loop primitive.
- Subscription event payloads are metadata-first. Package handlers receive the
  stored message id and receipt metadata, then use `email_message_get` or
  `email_attachment_get` (or `import { email } from 'kody:runtime'`) when they
  need bodies or attachment bytes.
- Subscription handlers run with the normal package runtime context: signed-in
  package user, package-owned storage via `packageStorage()`
  (`package:{encodeURIComponent(packageId)}`), package/repo context, and the
  standard capability registry subject to the usual secret and capability
  approval rules. For `email.message.received` and `email.message.quarantined`,
  `import { email }` from `kody:runtime` is available as a convenience helper
  for message lookup, attachment lookup, and replies.
- Attachments are metadata-first by default; raw MIME for small messages is
  stored so on-demand attachment lookup can reconstruct bytes locally.
- Cloudflare Email Routing already rejects mail that fails both SPF and DKIM and
  honors sender DMARC policy before Kody sees the message. Kody's own spam
  controls (below) run on mail that still reaches storage.

## Spam controls

Inbound mail is classified at receive time. Each stored message carries
`classification` (`accepted` or `quarantined`) and an optional human-readable
`classification_reason`. Decision order:

1. **Per-user sender rules** — exact address or domain match (domain rules also
   match subdomains). Address rules beat domain rules. Effects:
   - `block` rejects at SMTP before any receive quota is charged.
   - `quarantine` stores the message as quarantined.
   - `allow` stores the message as accepted and bypasses the auth-verdict
     quarantine step below.
2. **Authentication-Results verdict** — when no sender rule decides the outcome,
   Kody parses the stored SPF/DKIM/DMARC results. DMARC `fail`, or SPF
   `fail`/`softfail` without a DKIM `pass`, quarantines the message. A missing
   Authentication-Results header fails open to `accepted`.

Each user may store at most 200 sender rules. Manage them with
`email_sender_rule_list`, `email_sender_rule_set` (kind / value / effect /
note), and `email_sender_rule_delete`. Reclassify a stored inbound message with
`email_message_classify`, or filter `email_message_list` by `classification`.

On `/account/email`, quarantined messages show a Quarantined badge (with the
reason as tooltip/secondary text), the list can filter to Quarantined only, and
inbound messages offer Mark as spam / Not spam actions that call the same
reclassification path.

Subscription dispatch uses the receive-time classification exactly once:
accepted mail fires `email.message.received`; quarantined mail fires
`email.message.quarantined` instead. Later reclassification never retroactively
dispatches either topic.

## `email.message.received` package subscription

Accepted stored inbound email dispatches the package subscription topic
`email.message.received` after the message and attachment metadata are stored.
Quarantined mail uses `email.message.quarantined` instead (same payload shape,
different event name). Packages subscribe in `package.json#kody.subscriptions`:

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
`topic: "email.message.received"` or `topic: "email.message.quarantined"` to
discover which saved packages subscribe for the signed-in user.

## `email.message.quarantined` package subscription

Quarantined stored inbound email dispatches `email.message.quarantined` instead
of `email.message.received`. The payload shape matches
`EmailMessageReceivedEvent` with `event: 'email.message.quarantined'`. Packages
that should react to spam or suspect mail subscribe to this topic; packages that
only want trusted inbound mail stay on `email.message.received`.

## `email.message.delivery.updated` package subscription

Cloudflare Email Sending lifecycle events dispatch
`email.message.delivery.updated` after Kody correlates the provider message id,
stores the event idempotently, and updates the outbound message's latest
delivery status. Email Routing events are not part of this topic.

The metadata-first payload contains the owned Kody message and the provider
delivery event:

```ts
type EmailMessageDeliveryUpdatedEvent = {
	event: 'email.message.delivery.updated'
	message: {
		id: string
		inbox_id: string | null
		thread_id: string | null
		from_address: string | null
		to_addresses: Array<string>
		subject: string | null
		processing_status: 'stored' | 'sent' | 'failed'
		provider_message_id: string | null
		delivery_status:
			| 'delivered'
			| 'deferred'
			| 'bounced'
			| 'failed'
			| 'rejected'
			| 'complained'
			| null
		delivery_status_at: string | null
		sent_at: string | null
		created_at: string
	}
	delivery: {
		event_id: string
		status: NonNullable<
			EmailMessageDeliveryUpdatedEvent['message']['delivery_status']
		>
		terminal: boolean
		sender: string
		recipient: string
		delivery: Record<string, unknown>
		bounce: Record<string, unknown> | null
		failure: Record<string, unknown> | null
		rejection: Record<string, unknown> | null
		complaint: Record<string, unknown> | null
		occurred_at: string
	}
}
```

`deferred` means Cloudflare still has delivery retries pending; handlers should
not independently resend the message. Cloudflare automatically suppresses hard
bounces and spam complaints. Out-of-order events remain in delivery history but
do not dispatch after a newer delivery state has already been stored.

## `email.system-message.received` package subscription (admins)

Mail stored in the operator-owned system inbox (`kody`, `support`, `abuse`,
`postmaster`, `security`, and `admin` at the apex) dispatches the separate
package subscription topic `email.system-message.received` when the message is
accepted. It fans out to packages saved by users who hold the admin role at
dispatch time — a non-admin saving the same subscription never receives system
mail, and a revoked admin stops receiving immediately.

Quarantined system-inbox mail is stored for operators but never dispatches
`email.system-message.received` (or any other admin package subscription).
Operators manage system sender rules with `admin_system_email_sender_rule_list`,
`admin_system_email_sender_rule_set`, and
`admin_system_email_sender_rule_delete` (same address/domain matching and
effects as user sender rules, scoped to the `system:email` owner).

The payload is the same metadata-first envelope as `email.message.received`
(with `event: 'email.system-message.received'`), plus one extra field:

```ts
type SystemEmailMessageReceivedEvent = Omit<
	EmailMessageReceivedEvent,
	'event'
> & {
	event: 'email.system-message.received'
	/** Link to the stored message in the admin interface. */
	admin_url: string
}
```

Handlers run as the admin package owner, not the system owner, so the
user-scoped email capabilities and the `kody:runtime` `email` helper cannot read
the system message. Use the metadata for routing and notifications (for example
a Discord report), and follow `admin_url` (or the admin `admin_system_email_get`
capability) for full contents.

## Local inbound testing

Run the worker locally with `APP_BASE_URL` set, sign up a user, then post raw
MIME to Wrangler's email test endpoint addressed to
`{username}@inbox.<APP_BASE_URL hostname>` (or `{username}@<USER_EMAIL_DOMAIN>`
when the override is set). The local worker defaults to port `3742` unless you
set `PORT`:

```sh
curl --request POST \
  'http://localhost:3742/cdn-cgi/handler/email?from=sender@example.com&to=username@inbox.example.com' \
  --data-raw 'From: Sender <sender@example.com>
To: Username <username@inbox.example.com>
Subject: Hello
Message-ID: <hello@example.com>

Hello from local email routing.'
```

Then inspect the message with `email_message_list`, `email_message_search`, and
`email_message_get`.
