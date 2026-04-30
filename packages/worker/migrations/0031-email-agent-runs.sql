ALTER TABLE email_inboxes
ADD COLUMN owner_email TEXT;

ALTER TABLE email_inboxes
ADD COLUMN owner_display_name TEXT;

CREATE TABLE IF NOT EXISTS email_delivery_events_v2 (
	id TEXT PRIMARY KEY,
	message_id TEXT,
	user_id TEXT,
	inbox_id TEXT,
	event_type TEXT NOT NULL CHECK (
		event_type IN (
			'receive_started',
			'received',
			'quarantined',
			'rejected',
			'agent_loop_started',
			'agent_loop_completed',
			'agent_loop_limit_reached',
			'agent_loop_failed',
			'send_requested',
			'sent',
			'failed',
			'policy_matched'
		)
	),
	provider TEXT NOT NULL DEFAULT 'kody',
	provider_message_id TEXT,
	detail_json TEXT NOT NULL DEFAULT '{}',
	created_at TEXT NOT NULL,
	FOREIGN KEY (message_id) REFERENCES email_messages(id) ON DELETE SET NULL,
	FOREIGN KEY (inbox_id) REFERENCES email_inboxes(id) ON DELETE SET NULL
);

INSERT INTO email_delivery_events_v2 (
	id,
	message_id,
	user_id,
	inbox_id,
	event_type,
	provider,
	provider_message_id,
	detail_json,
	created_at
)
SELECT
	id,
	message_id,
	user_id,
	inbox_id,
	event_type,
	provider,
	provider_message_id,
	detail_json,
	created_at
FROM email_delivery_events;

DROP TABLE email_delivery_events;

ALTER TABLE email_delivery_events_v2 RENAME TO email_delivery_events;

CREATE INDEX IF NOT EXISTS idx_email_delivery_events_message_id
ON email_delivery_events(message_id);

CREATE INDEX IF NOT EXISTS idx_email_delivery_events_user_created_at
ON email_delivery_events(user_id, created_at);

CREATE TABLE IF NOT EXISTS email_agent_runs (
	id TEXT PRIMARY KEY,
	user_id TEXT NOT NULL,
	inbox_id TEXT,
	thread_id TEXT,
	inbound_message_id TEXT NOT NULL,
	reply_message_id TEXT,
	session_id TEXT NOT NULL,
	conversation_id TEXT NOT NULL,
	status TEXT NOT NULL CHECK (
		status IN ('running', 'completed', 'limit_reached', 'failed')
	),
	tool_call_limit INTEGER NOT NULL,
	tool_calls_used INTEGER NOT NULL DEFAULT 0,
	trace_url TEXT,
	summary TEXT,
	assistant_text TEXT,
	stop_reason TEXT,
	finish_reason TEXT,
	error TEXT,
	started_at TEXT NOT NULL,
	completed_at TEXT,
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL,
	FOREIGN KEY (inbox_id) REFERENCES email_inboxes(id) ON DELETE SET NULL,
	FOREIGN KEY (thread_id) REFERENCES email_threads(id) ON DELETE SET NULL,
	FOREIGN KEY (inbound_message_id) REFERENCES email_messages(id) ON DELETE CASCADE,
	FOREIGN KEY (reply_message_id) REFERENCES email_messages(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_email_agent_runs_inbound_message_id
ON email_agent_runs(inbound_message_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_email_agent_runs_reply_message_id
ON email_agent_runs(reply_message_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_email_agent_runs_user_created_at
ON email_agent_runs(user_id, created_at DESC);
