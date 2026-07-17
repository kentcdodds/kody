ALTER TABLE email_messages
ADD COLUMN delivery_status TEXT
CHECK (
	delivery_status IS NULL
	OR delivery_status IN (
		'delivered',
		'deferred',
		'bounced',
		'failed',
		'rejected',
		'complained'
	)
);

ALTER TABLE email_messages
ADD COLUMN delivery_status_at TEXT;

UPDATE email_messages
SET provider_message_id = NULL
WHERE id IN (
	SELECT id
	FROM (
		SELECT
			id,
			ROW_NUMBER() OVER (
				PARTITION BY provider_message_id
				ORDER BY created_at ASC, id ASC
			) AS provider_id_ordinal
		FROM email_messages
		WHERE direction = 'outbound'
			AND provider_message_id IS NOT NULL
	)
	WHERE provider_id_ordinal > 1
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_email_messages_provider_message_id
ON email_messages(provider_message_id)
WHERE direction = 'outbound'
	AND provider_message_id IS NOT NULL;

CREATE TABLE email_delivery_events_next (
	id TEXT PRIMARY KEY,
	message_id TEXT,
	user_id TEXT,
	inbox_id TEXT,
	event_type TEXT NOT NULL CHECK (
		event_type IN (
			'receive_started',
			'received',
			'rejected',
			'send_requested',
			'sent',
			'failed',
			'delivered',
			'deferred',
			'bounced',
			'complained'
		)
	),
	provider TEXT NOT NULL DEFAULT 'kody',
	provider_message_id TEXT,
	provider_event_id TEXT,
	detail_json TEXT NOT NULL DEFAULT '{}',
	created_at TEXT NOT NULL,
	FOREIGN KEY (message_id) REFERENCES email_messages(id) ON DELETE SET NULL,
	FOREIGN KEY (inbox_id) REFERENCES email_inboxes(id) ON DELETE SET NULL
);

INSERT INTO email_delivery_events_next (
	id,
	message_id,
	user_id,
	inbox_id,
	event_type,
	provider,
	provider_message_id,
	provider_event_id,
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
	NULL,
	detail_json,
	created_at
FROM email_delivery_events;

DROP TABLE email_delivery_events;
ALTER TABLE email_delivery_events_next RENAME TO email_delivery_events;

CREATE INDEX IF NOT EXISTS idx_email_delivery_events_message_id
ON email_delivery_events(message_id);

CREATE INDEX IF NOT EXISTS idx_email_delivery_events_user_created_at
ON email_delivery_events(user_id, created_at);

CREATE INDEX IF NOT EXISTS idx_email_delivery_events_created_at
ON email_delivery_events(created_at);

CREATE UNIQUE INDEX IF NOT EXISTS idx_email_delivery_events_provider_event_id
ON email_delivery_events(provider_event_id)
WHERE provider_event_id IS NOT NULL;
