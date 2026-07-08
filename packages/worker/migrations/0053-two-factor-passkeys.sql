CREATE TABLE IF NOT EXISTS verifications (
	id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
	type TEXT NOT NULL,
	target TEXT NOT NULL,
	secret TEXT NOT NULL,
	algorithm TEXT NOT NULL,
	digits INTEGER NOT NULL,
	period INTEGER NOT NULL,
	char_set TEXT NOT NULL,
	expires_at INTEGER,
	created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
	UNIQUE (target, type)
);

CREATE INDEX IF NOT EXISTS idx_verifications_target_type ON verifications(target, type);

CREATE TABLE IF NOT EXISTS passkeys (
	id TEXT PRIMARY KEY NOT NULL,
	aaguid TEXT NOT NULL,
	public_key TEXT NOT NULL,
	user_id INTEGER NOT NULL,
	webauthn_user_handle TEXT NOT NULL,
	counter INTEGER NOT NULL DEFAULT 0,
	device_type TEXT NOT NULL,
	backed_up INTEGER NOT NULL DEFAULT 0,
	transports TEXT,
	created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
	updated_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
	FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_passkeys_user_id ON passkeys(user_id);
