-- Credentials plan v4 section 3.2 (ADR 0068): a personal credential is a
-- credential in its owner's personal org. The owner grants it to another org
-- one org at a time; it then works only in the owner's own runs in that org.
-- `user_id` is the owner's person id. Leaving the org hard-deletes the row.
-- Nothing reads this table on the placeholder lane.

CREATE TABLE credential_org_grants (
	credential_id TEXT NOT NULL,
	user_id TEXT NOT NULL,
	org_id TEXT NOT NULL,
	created_at TEXT NOT NULL,
	PRIMARY KEY (credential_id, org_id)
);

CREATE INDEX credential_org_grants_org_user ON credential_org_grants (org_id, user_id);
CREATE INDEX credential_org_grants_user ON credential_org_grants (user_id);
