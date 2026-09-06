-- Emails are claims on an account. `users.stable_user_id` stays the identity
-- minted at signup and is never reminted when the login email changes.
-- Changing email keeps the previous verified address claimed so it cannot
-- open a second account until the owner re-verifies and releases it.

CREATE TABLE user_email_claims (
	id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
	user_id INTEGER NOT NULL,
	email TEXT NOT NULL,
	status TEXT NOT NULL CHECK (status IN ('claimed', 'released')),
	claimed_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
	released_at TEXT,
	created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
	updated_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
	FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
	UNIQUE (user_id, email)
);

CREATE UNIQUE INDEX idx_user_email_claims_active_email
	ON user_email_claims(email)
	WHERE status = 'claimed';

CREATE INDEX idx_user_email_claims_user_id
	ON user_email_claims(user_id);

INSERT INTO user_email_claims (user_id, email, status)
SELECT id, email, 'claimed' FROM users;

CREATE TABLE pending_email_claim_releases (
	id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
	user_id INTEGER NOT NULL,
	email TEXT NOT NULL,
	token_hash TEXT NOT NULL UNIQUE,
	expires_at INTEGER NOT NULL,
	created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
	FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX idx_pending_email_claim_releases_user_email
	ON pending_email_claim_releases(user_id, email);
