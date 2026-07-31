-- Keep scheduled inbound-effect reconciliation and durable usage aggregation
-- off the retained JSON event ledger. A default of 1 safely covers received
-- events written by an older Worker between this migration and the deploy;
-- partial indexes exclude unrelated delivery-event rows.

ALTER TABLE email_delivery_events
ADD COLUMN needs_effect_reconcile INTEGER NOT NULL DEFAULT 1
CHECK (needs_effect_reconcile IN (0, 1));

ALTER TABLE email_delivery_events
ADD COLUMN usage_effect_recorded_at TEXT;

ALTER TABLE email_delivery_events
ADD COLUMN usage_month TEXT;

ALTER TABLE email_delivery_events
ADD COLUMN usage_bytes INTEGER;

ALTER TABLE email_delivery_events
ADD COLUMN usage_duration_ms INTEGER;

UPDATE email_delivery_events
SET
	usage_effect_recorded_at = json_extract(
		detail_json,
		'$.usageEffectRecordedAt'
	),
	usage_month = COALESCE(
		json_extract(detail_json, '$.usageMonth'),
		(
			SELECT substr(
				COALESCE(message.received_at, message.created_at),
				1,
				7
			)
			FROM email_messages message
			WHERE message.id = email_delivery_events.message_id
				AND message.user_id = email_delivery_events.user_id
		)
	),
	usage_bytes = COALESCE(
		json_extract(detail_json, '$.usageBytes'),
		(
			SELECT COALESCE(message.raw_size, 0)
			FROM email_messages message
			WHERE message.id = email_delivery_events.message_id
				AND message.user_id = email_delivery_events.user_id
		)
	),
	usage_duration_ms = COALESCE(
		json_extract(detail_json, '$.usageDurationMs'),
		0
	)
WHERE provider = 'cloudflare-email-routing'
	AND event_type = 'received'
	AND json_extract(detail_json, '$.usageEffectRecordedAt') IS NOT NULL;

UPDATE email_delivery_events
SET needs_effect_reconcile = CASE
	WHEN provider = 'cloudflare-email-routing'
		AND event_type = 'received'
		AND json_extract(detail_json, '$.fingerprint') IS NOT NULL
		AND (
			(
				json_extract(detail_json, '$.usageEffectRecordedAt') IS NULL
				AND json_extract(detail_json, '$.usageEffectSuppressedAt') IS NULL
			)
			OR (
				json_extract(detail_json, '$.subscriptionEffectState') IS NULL
				OR json_extract(
					detail_json,
					'$.subscriptionEffectState'
				) NOT IN ('complete', 'dead-letter')
			)
			OR (
				json_extract(detail_json, '$.usageEffectRecordedAt') IS NOT NULL
				AND (usage_month IS NULL OR usage_bytes IS NULL)
				AND (
					(
						json_extract(detail_json, '$.usageMonth') IS NOT NULL
						AND json_extract(detail_json, '$.usageBytes') IS NOT NULL
					)
					OR EXISTS (
						SELECT 1
						FROM email_messages message
						WHERE message.id = email_delivery_events.message_id
							AND message.user_id = email_delivery_events.user_id
					)
				)
			)
		)
	THEN 1
	ELSE 0
END;

CREATE INDEX IF NOT EXISTS idx_email_delivery_events_pending_effects
ON email_delivery_events(user_id, created_at)
WHERE provider = 'cloudflare-email-routing'
	AND event_type = 'received'
	AND needs_effect_reconcile = 1;

CREATE INDEX IF NOT EXISTS idx_email_delivery_events_recorded_usage_month
ON email_delivery_events(usage_month, user_id)
WHERE provider = 'cloudflare-email-routing'
	AND event_type = 'received'
	AND usage_effect_recorded_at IS NOT NULL;
