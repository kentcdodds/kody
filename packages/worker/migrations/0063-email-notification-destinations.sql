-- Extra verified addresses Kody may notify via emailSend, beyond users.email.
-- Identity email is not stored here; it is always synthesized at read time.
-- At most one additional destination may be the default; when none is marked,
-- emailSend with `to` omitted uses the identity email.
CREATE TABLE email_notification_destinations (
	id TEXT PRIMARY KEY NOT NULL,
	user_id INTEGER NOT NULL,
	email TEXT NOT NULL,
	verified_at TEXT,
	is_default INTEGER NOT NULL DEFAULT 0 CHECK (is_default IN (0, 1)),
	created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
	FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX idx_email_notification_destinations_user_email
	ON email_notification_destinations(user_id, email);

CREATE INDEX idx_email_notification_destinations_user_id
	ON email_notification_destinations(user_id);

CREATE UNIQUE INDEX idx_email_notification_destinations_user_default
	ON email_notification_destinations(user_id)
	WHERE is_default = 1;

CREATE TABLE pending_email_destination_verifications (
	id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
	user_id INTEGER NOT NULL,
	destination_id TEXT NOT NULL,
	token_hash TEXT NOT NULL UNIQUE,
	expires_at INTEGER NOT NULL,
	created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
	FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
	FOREIGN KEY (destination_id) REFERENCES email_notification_destinations(id)
		ON DELETE CASCADE
);

CREATE INDEX idx_pending_email_destination_verifications_destination
	ON pending_email_destination_verifications(destination_id);
