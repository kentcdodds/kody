# Mailbox legacy graph drop

Migration `0135-drop-legacy-email-graph.sql` is destructive and remains
conductor-controlled. Migration 0134 only installs the canonical approval
schema. Direct production SQL is never an approval path.

## Canonical approval process

1. Confirm migration 0134 and the backup control plane are deployed.
2. Generate a UUID request id, a 32-character lowercase hexadecimal nonce, and a
   canonical UTC `requestedAt`.
3. Trigger `kody-mailbox-legacy-graph-pre-drop-backup` through the Cloudflare
   Workflow API. `params` is an object, not a JSON string.

Example request body:

```json
{
	"instance_id": "mailbox-pre-drop-11111111-1111-4111-8111-111111111111",
	"params": {
		"requestId": "11111111-1111-4111-8111-111111111111",
		"nonce": "0123456789abcdef0123456789abcdef",
		"requestedAt": "2026-08-03T19:00:00.000Z"
	}
}
```

4. Poll that exact instance until `result.status` is `complete`.
5. Retain the non-secret approval receipt. Confirm its `requestId` and `nonce`,
   immutable manifest/SQL keys, SQL bytes/SHA-256/R2 ETag, signing key and
   signature digest, source identity, export/build/baseline provenance, frozen
   marker, exact counts, issuer, verification time, and expiration.
6. Apply 0135 only while that receipt is unexpired. Approval lasts at most two
   hours. If conductor merge occurs after expiration, trigger a new Workflow
   instance with a new request id, nonce, and timestamp.

Production applied 0135 at `2026-08-03T22:55:40Z` under control-plane receipt
`963be2ed-0462-4294-ae63-81b8a5ddac38` (verified `2026-08-03T22:30:57.969Z`,
expired `2026-08-04T00:30:57.969Z`). Receipts are not embedded in 0135. A newer
receipt may replace an unconsumed one, but it must come from the same deployed
trust configuration: source account `a99ee2e72728dd52902ef288b7b1447d`, database
`8c1014d1-6b41-4695-a0a2-159071f0f919` / `kody`, key `kody-dr-2026-07`, baseline
`kody-migration-set-2026-07` /
`feb76eb26ed72a55d5fa25d14ef9ee904d0758fc29842c898b584a921ccfd995`, and build
`fe1ca2772de7f369fc06a7d1bd9aeadc3347b2a7`. The migration does not pin the
request id, request nonce, manifest/SQL object keys, SQL SHA-256, R2 ETag, or
manifest-signature digest.

The frozen table inventory in 0135 rejects unexpected user tables. Live APP_DB
may contain the runtime auth throttle scratch table `_rate_limits` (created by
`packages/worker/src/app/rate-limit.ts`, not migration-managed). That table is
safe to `DROP TABLE IF EXISTS` immediately before applying 0135; the worker
recreates it on demand. Do not hand-edit `email_user_graph_drop_approval` or
other approval evidence.

The first attempt that encoded `params` as a string failed and is irrelevant: it
issued no receipt and cannot authorize the migration. Never update or recreate
`email_user_graph_drop_approval` by hand.

## Exact deploy preflight

The canonical preflight is the SQL before the first destructive statement in
`packages/worker/migrations/0135-drop-legacy-email-graph.sql`. It runs in the
same Wrangler D1 transaction as the drop and aborts on any failed CHECK. It
requires:

- all canonical 0134 approval provenance, including source, signing,
  restore-baseline, control-plane-build, and object evidence, bound to the
  current 0133 marker and a currently valid two-hour verification window;
- exact frozen USER owner/thread/message/attachment/event counts;
- no provider-index repair owner and no `cutover-audit` due-owner backlog;
- a valid dedicated system authority marker, zero system provider links, and
  bidirectional full-column legacy/dedicated system parity;
- no unexpected trigger, view, or foreign-key dependency on the shared graph,
  and clean foreign-key checks before and after the rebuild/drop.

There is one approval-free bootstrap path for a database that has never held an
email graph. It requires no approval row, `owner_count = 0`, zero total rows
(including `system:email`) in all four shared tables, and empty provider-index,
repair-owner, due-owner, inbound-usage-effect, and dedicated-system graph
surfaces. The dedicated authority marker must also be healthy. A single legacy
row or a nonzero authority marker closes this path and requires a valid
control-plane receipt. This is what lets a newly created preview database apply
the universal migration chain before test-data seeding.

`email_inbound_usage_effects` is intentionally retained. The 0134 signed
contract has no count for it, so 0135 preserves every row and detaches only its
obsolete foreign key. It is an idempotency ledger, expected to age toward zero,
not approved drop data.

Do not copy a reduced status query into deployment automation. The migration
preflight is the exact final authority check coupled atomically to the
destructive statements.

## Final storage and restore state

USER thread/message/attachment/event authority is Mailbox Durable Object SQLite;
USER raw MIME and external attachment bytes remain in `EMAIL_BLOBS`. Dedicated
`system_email_*` tables remain the operator inbox authority. D1 retains
low-write mail configuration, the thin provider reverse index, the detached
inbound usage idempotency ledger, and the cutover marker. Environments that used
the destructive approval path also retain the complete canonical approval
receipt; empty bootstraps have no synthetic receipt.

For inspection, verify the receipt's manifest signature and SQL bytes/SHA-256/
ETag, import into an isolated D1 database, run `PRAGMA foreign_key_check`, and
keep that database disconnected from live Workers. A production recovery to the
pre-drop schema requires maintenance mode and a separately reviewed conductor
plan; it must not reintroduce the retired D1-to-Mailbox mirror.
