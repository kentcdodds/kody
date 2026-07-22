-- Stage 5: contract email_sender_identities.status to verified-only.
-- Platform-assigned sender identities are always provisioned verified; legacy
-- pending/disabled values are stale bookkeeping with no authorization meaning.
--
-- Cloudflare D1 wraps each migration in a transaction, so PRAGMA foreign_keys=OFF
-- is a no-op there. email_messages.sender_identity_id references this table with
-- ON DELETE SET NULL, so DROP TABLE would null those FKs. Snapshot every
-- non-null sender_identity_id, rebuild identities, then restore the references.
--
-- Fail-closed: after restore, any unrecovered message linkage aborts (and D1
-- rolls the transaction back).

UPDATE email_sender_identities
SET
	status = 'verified',
	verified_at = COALESCE(verified_at, created_at);

CREATE TABLE _mig0078_email_message_sender_refs AS
SELECT id AS message_id, sender_identity_id
FROM email_messages
WHERE sender_identity_id IS NOT NULL;

CREATE TABLE email_sender_identities_next (
	id TEXT PRIMARY KEY,
	user_id TEXT NOT NULL,
	package_id TEXT,
	email TEXT NOT NULL,
	domain TEXT,
	display_name TEXT NOT NULL DEFAULT '',
	status TEXT NOT NULL CHECK (status IN ('verified')),
	verified_at TEXT,
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL
);

INSERT INTO email_sender_identities_next (
	id,
	user_id,
	package_id,
	email,
	domain,
	display_name,
	status,
	verified_at,
	created_at,
	updated_at
)
SELECT
	id,
	user_id,
	package_id,
	email,
	domain,
	display_name,
	status,
	verified_at,
	created_at,
	updated_at
FROM email_sender_identities;

DROP TABLE email_sender_identities;

ALTER TABLE email_sender_identities_next RENAME TO email_sender_identities;

CREATE UNIQUE INDEX IF NOT EXISTS idx_email_sender_identities_user_email
ON email_sender_identities(user_id, email);

CREATE INDEX IF NOT EXISTS idx_email_sender_identities_user_domain
ON email_sender_identities(user_id, domain);

UPDATE email_messages
SET sender_identity_id = (
	SELECT refs.sender_identity_id
	FROM _mig0078_email_message_sender_refs AS refs
	WHERE refs.message_id = email_messages.id
)
WHERE id IN (
	SELECT message_id
	FROM _mig0078_email_message_sender_refs
);

CREATE TABLE __migration_assertions (
	message TEXT NOT NULL CHECK (0)
);

INSERT INTO __migration_assertions (message)
SELECT 'email_messages.sender_identity_id restore incomplete after 0078 rebuild.'
WHERE EXISTS (
	SELECT 1
	FROM _mig0078_email_message_sender_refs AS refs
	WHERE NOT EXISTS (
		SELECT 1
		FROM email_messages AS message
		WHERE message.id = refs.message_id
			AND message.sender_identity_id = refs.sender_identity_id
	)
);

DROP TABLE __migration_assertions;

DROP TABLE _mig0078_email_message_sender_refs;
