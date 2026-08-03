-- Step 5a prerequisite: keep the global provider reverse lookup in D1 while
-- detaching it from the legacy USER email_messages graph. Wrangler applies this
-- migration file atomically, so a failed copy restores the original table.
--
-- system:email has dedicated D1 graph authority and does not support outbound
-- provider links. USER message authority moves to Mailbox in the next slice;
-- message_id therefore remains an opaque owner-scoped lookup key, not a
-- cross-store foreign key.

CREATE TABLE email_outbound_provider_index_next (
	provider TEXT NOT NULL,
	provider_message_id TEXT NOT NULL,
	user_id TEXT NOT NULL CHECK (user_id <> 'system:email'),
	message_id TEXT NOT NULL,
	inbox_id TEXT,
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL,
	PRIMARY KEY (provider, provider_message_id)
);

INSERT INTO email_outbound_provider_index_next (
	provider,
	provider_message_id,
	user_id,
	message_id,
	inbox_id,
	created_at,
	updated_at
)
SELECT
	provider,
	provider_message_id,
	user_id,
	message_id,
	inbox_id,
	created_at,
	updated_at
FROM email_outbound_provider_index;

DROP TABLE email_outbound_provider_index;

ALTER TABLE email_outbound_provider_index_next
	RENAME TO email_outbound_provider_index;

CREATE INDEX idx_email_outbound_provider_index_user_id
	ON email_outbound_provider_index(user_id);

CREATE UNIQUE INDEX idx_email_outbound_provider_index_message_id
	ON email_outbound_provider_index(message_id);

-- Preserve the old FK's rollback behavior while legacy email_messages remains.
-- SQLite runs trigger statements in the same transaction as the DELETE, so a
-- failure rolls back both the message and index cleanup. Step 5b removes this
-- compatibility trigger with the legacy table.
CREATE TRIGGER email_messages_delete_outbound_provider_index
AFTER DELETE ON email_messages
BEGIN
	DELETE FROM email_outbound_provider_index
	WHERE message_id = OLD.id;
END;
