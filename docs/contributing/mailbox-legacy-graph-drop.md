# Mailbox legacy graph drop

Migration `0134-drop-legacy-email-graph.sql` is destructive and must remain
conductor-controlled. It is valid only after 0133 is deployed and a fresh D1
backup has been downloaded, SHA-256 verified, and retained immutably.

The older recorded SHA-256 beginning `7787f8c9` is historical evidence only. Do
not use it to approve 0134: the approval must identify the fresh backup taken
immediately before the conductor deploy.

## Direct production approval SQL

Create this table by direct production D1 SQL after the fresh backup is
verified. The shape must match exactly:

```sql
CREATE TABLE email_user_graph_drop_approval (
	singleton INTEGER PRIMARY KEY NOT NULL CHECK (singleton = 1),
	authority_frozen_at TEXT NOT NULL,
	backup_object_key TEXT NOT NULL,
	backup_sha256 TEXT NOT NULL,
	verified_at TEXT NOT NULL,
	expires_at TEXT NOT NULL,
	owner_count INTEGER NOT NULL CHECK (owner_count >= 0),
	thread_count INTEGER NOT NULL CHECK (thread_count >= 0),
	message_count INTEGER NOT NULL CHECK (message_count >= 0),
	attachment_count INTEGER NOT NULL CHECK (attachment_count >= 0),
	delivery_event_count INTEGER NOT NULL CHECK (delivery_event_count >= 0)
);
```

Replace the two angle-bracket values below. The object key must identify the
verified fresh backup and the SHA-256 must be 64 lowercase hexadecimal
characters. This statement inserts nothing if the deployed 0133 marker or frozen
USER counts differ from the recorded production evidence:

```sql
INSERT INTO email_user_graph_drop_approval (
	singleton,
	authority_frozen_at,
	backup_object_key,
	backup_sha256,
	verified_at,
	expires_at,
	owner_count,
	thread_count,
	message_count,
	attachment_count,
	delivery_event_count
)
SELECT
	1,
	authority.frozen_at,
	'<FRESH_BACKUP_OBJECT_KEY>',
	'<FRESH_BACKUP_SHA256_LOWERCASE>',
	strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
	strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '+2 hours'),
	3,
	106,
	194,
	48,
	295
FROM email_user_graph_authority authority
WHERE authority.singleton = 1
	AND authority.owner_count = 3
	AND authority.frozen_at = '2026-08-03T14:53:49Z'
	AND (SELECT COUNT(*) FROM email_threads
		WHERE user_id != 'system:email') = 106
	AND (SELECT COUNT(*) FROM email_messages
		WHERE user_id != 'system:email') = 194
	AND (
		SELECT COUNT(*)
		FROM email_attachments attachment
		INNER JOIN email_messages message ON message.id = attachment.message_id
		WHERE message.user_id != 'system:email'
	) = 48
	AND (SELECT COUNT(*) FROM email_delivery_events
		WHERE user_id != 'system:email') = 295;
```

Run this verification query immediately afterward. It must return exactly one
row with `approved = 1`:

```sql
SELECT
	COUNT(*) = 1
	AND authority_frozen_at = '2026-08-03T14:53:49Z'
	AND owner_count = 3
	AND thread_count = 106
	AND message_count = 194
	AND attachment_count = 48
	AND delivery_event_count = 295
	AND length(trim(backup_object_key)) > 0
	AND length(backup_sha256) = 64
	AND backup_sha256 = lower(backup_sha256)
	AND backup_sha256 NOT GLOB '*[^0-9a-f]*'
	AND julianday(verified_at) <= julianday('now')
	AND julianday(expires_at) > julianday('now')
	AS approved
FROM email_user_graph_drop_approval
WHERE singleton = 1;
```

## Exact deploy preflight

The canonical preflight is the SQL before the first destructive statement in
`packages/worker/migrations/0134-drop-legacy-email-graph.sql`. It runs in the
same Wrangler D1 transaction as the drop and aborts on any failed CHECK. It
requires:

- the current, well-formed approval above, bound to the 0133 `frozen_at` and
  owner count;
- exact frozen USER owner/thread/message/attachment/event counts;
- no provider-index repair owner and no `cutover-audit` due-owner backlog;
- a valid dedicated system authority marker and zero system provider links;
- bidirectional ID and full-column parity for all four legacy/dedicated system
  tables;
- no unexpected trigger, view, or foreign-key dependency on the shared graph,
  and a clean `pragma_foreign_key_check`.

Do not copy a reduced status query into deployment automation. The migration
preflight is intentionally the exact final authority check and is coupled to the
destructive statements atomically.

## Restore

Retain the approved object and its SHA-256 after deploy. For inspection, verify
the downloaded bytes against the marker, import into an isolated D1 database,
verify the approved manifest and `PRAGMA foreign_key_check`, and keep that
database disconnected from live Workers. USER recovery remains
Mailbox/`EMAIL_BLOBS` authoritative. A full production D1 restore to 0133 state
requires maintenance mode and a reviewed conductor plan to recreate a fresh
approval and reapply 0134.
