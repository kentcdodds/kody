CREATE TABLE IF NOT EXISTS mcp_memories (
	id TEXT PRIMARY KEY NOT NULL,
	user_id TEXT NOT NULL,
	category TEXT,
	status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'deleted', 'archived')),
	subject TEXT NOT NULL,
	summary TEXT NOT NULL,
	details TEXT NOT NULL DEFAULT '',
	tags_json TEXT NOT NULL DEFAULT '[]',
	dedupe_key TEXT,
	created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
	updated_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
	last_accessed_at TEXT,
	deleted_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_mcp_memories_user_status_updated
	ON mcp_memories(user_id, status, updated_at);

CREATE INDEX IF NOT EXISTS idx_mcp_memories_user_category_status
	ON mcp_memories(user_id, category, status);

CREATE INDEX IF NOT EXISTS idx_mcp_memories_user_dedupe_key
	ON mcp_memories(user_id, dedupe_key);

CREATE TABLE IF NOT EXISTS mcp_memory_conversation_suppressions (
	user_id TEXT NOT NULL,
	conversation_id TEXT NOT NULL,
	memory_id TEXT NOT NULL,
	created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
	last_seen_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
	expires_at TEXT NOT NULL,
	PRIMARY KEY (user_id, conversation_id, memory_id),
	FOREIGN KEY (memory_id) REFERENCES mcp_memories(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_mcp_memory_suppressions_expires_at
	ON mcp_memory_conversation_suppressions(expires_at);
