-- Track Cloudflare Email Sending lifecycle for signup/verify mail, and
-- persist the latest delivery outcome on the user so bounced verification
-- is visible instead of a silent pending state.
ALTER TABLE users ADD COLUMN email_verification_delivery_status TEXT;
ALTER TABLE users ADD COLUMN email_verification_delivery_at TEXT;
ALTER TABLE users ADD COLUMN email_verification_delivery_detail TEXT;
ALTER TABLE users ADD COLUMN email_verification_delivery_class TEXT;

CREATE TABLE transactional_email_delivery_index (
	provider_message_id TEXT PRIMARY KEY NOT NULL,
	user_id INTEGER NOT NULL,
	kind TEXT NOT NULL,
	recipient TEXT NOT NULL,
	created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
	FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX idx_transactional_email_delivery_user_id
	ON transactional_email_delivery_index(user_id);
