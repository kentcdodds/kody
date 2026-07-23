CREATE TABLE account_write_leases (
	token TEXT PRIMARY KEY NOT NULL,
	user_id TEXT NOT NULL,
	holder TEXT NOT NULL,
	acquired_at TEXT NOT NULL,
	released_at TEXT
);

CREATE INDEX idx_account_write_leases_active_user
ON account_write_leases(user_id)
WHERE released_at IS NULL;

CREATE TABLE account_write_lease_repairs (
	id TEXT PRIMARY KEY NOT NULL,
	target_user_id TEXT NOT NULL,
	lease_token TEXT NOT NULL,
	lease_holder TEXT NOT NULL,
	lease_acquired_at TEXT NOT NULL,
	repaired_by_user_id TEXT NOT NULL,
	reason TEXT NOT NULL,
	created_at TEXT NOT NULL
);
