-- Step 4b authority marker. The dedicated system_email_* graph is now the
-- system:email read/write authority. Legacy shared rows remain atomic rollback
-- mirrors through step 5 and are intentionally not deleted by this migration.

CREATE TABLE IF NOT EXISTS system_email_graph_authority (
	singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
	authority TEXT NOT NULL CHECK (authority = 'dedicated'),
	cutover_at TEXT NOT NULL
);

INSERT OR IGNORE INTO system_email_graph_authority (
	singleton,
	authority,
	cutover_at
) VALUES (1, 'dedicated', CURRENT_TIMESTAMP);
