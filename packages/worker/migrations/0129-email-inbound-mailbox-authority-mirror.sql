-- USER inbound delivery authority now lives in the per-owner Mailbox Durable
-- Object. These columns are a complete compatibility projection used for
-- synchronous D1 graph-write fences and global scheduled owner discovery.
-- system:email continues to use the same D1 row as its authority.

ALTER TABLE email_delivery_events ADD COLUMN state TEXT
CHECK (
	state IS NULL
	OR state IN (
		'pending', 'storing', 'cleaning', 'received', 'rejected', 'orphan-cleaned'
	)
);
ALTER TABLE email_delivery_events ADD COLUMN fingerprint TEXT;
ALTER TABLE email_delivery_events ADD COLUMN storage_lease TEXT;
ALTER TABLE email_delivery_events ADD COLUMN storage_lease_at TEXT;
ALTER TABLE email_delivery_events ADD COLUMN cleanup_lease TEXT;
ALTER TABLE email_delivery_events ADD COLUMN cleanup_lease_at TEXT;
ALTER TABLE email_delivery_events ADD COLUMN cleanup_retry_at TEXT;
ALTER TABLE email_delivery_events ADD COLUMN expected_attachment_count INTEGER;
ALTER TABLE email_delivery_events ADD COLUMN finalization_token TEXT;
ALTER TABLE email_delivery_events ADD COLUMN reconcile_after TEXT;
ALTER TABLE email_delivery_events ADD COLUMN dedupe_expires_at TEXT;
ALTER TABLE email_delivery_events ADD COLUMN usage_effect_suppressed_at TEXT;
ALTER TABLE email_delivery_events ADD COLUMN usage_started_at TEXT;
ALTER TABLE email_delivery_events ADD COLUMN usage_effect_retry_at TEXT;
ALTER TABLE email_delivery_events ADD COLUMN usage_effect_lease TEXT;
ALTER TABLE email_delivery_events ADD COLUMN usage_effect_lease_at TEXT;
ALTER TABLE email_delivery_events ADD COLUMN subscription_effect_state TEXT
CHECK (
	subscription_effect_state IS NULL
	OR subscription_effect_state IN ('pending', 'processing', 'complete', 'dead-letter')
);
ALTER TABLE email_delivery_events ADD COLUMN subscription_effect_lease TEXT;
ALTER TABLE email_delivery_events ADD COLUMN subscription_effect_lease_at TEXT;
ALTER TABLE email_delivery_events ADD COLUMN subscription_effect_retry_at TEXT;
ALTER TABLE email_delivery_events ADD COLUMN subscription_effect_attempt_count INTEGER;
ALTER TABLE email_delivery_events ADD COLUMN subscription_effect_dead_letter_at TEXT;
ALTER TABLE email_delivery_events ADD COLUMN subscription_effect_last_error TEXT;
ALTER TABLE email_delivery_events ADD COLUMN updated_at TEXT;

UPDATE email_delivery_events
SET
	state = json_extract(detail_json, '$.state'),
	fingerprint = json_extract(detail_json, '$.fingerprint'),
	storage_lease = json_extract(detail_json, '$.storageLease'),
	storage_lease_at = json_extract(detail_json, '$.storageLeaseAt'),
	cleanup_lease = json_extract(detail_json, '$.cleanupLease'),
	cleanup_lease_at = json_extract(detail_json, '$.cleanupLeaseAt'),
	cleanup_retry_at = json_extract(detail_json, '$.cleanupRetryAt'),
	expected_attachment_count = json_extract(
		detail_json,
		'$.expectedAttachmentCount'
	),
	finalization_token = json_extract(detail_json, '$.finalizationToken'),
	reconcile_after = json_extract(detail_json, '$.reconcileAfter'),
	dedupe_expires_at = json_extract(detail_json, '$.dedupeExpiresAt'),
	usage_effect_suppressed_at = json_extract(
		detail_json,
		'$.usageEffectSuppressedAt'
	),
	usage_started_at = json_extract(detail_json, '$.usageStartedAt'),
	usage_effect_retry_at = json_extract(detail_json, '$.usageEffectRetryAt'),
	usage_effect_lease = json_extract(detail_json, '$.usageEffectLease'),
	usage_effect_lease_at = json_extract(detail_json, '$.usageEffectLeaseAt'),
	subscription_effect_state = json_extract(
		detail_json,
		'$.subscriptionEffectState'
	),
	subscription_effect_lease = json_extract(
		detail_json,
		'$.subscriptionEffectLease'
	),
	subscription_effect_lease_at = json_extract(
		detail_json,
		'$.subscriptionEffectLeaseAt'
	),
	subscription_effect_retry_at = json_extract(
		detail_json,
		'$.subscriptionEffectRetryAt'
	),
	subscription_effect_attempt_count = json_extract(
		detail_json,
		'$.subscriptionEffectAttemptCount'
	),
	subscription_effect_dead_letter_at = json_extract(
		detail_json,
		'$.subscriptionEffectDeadLetterAt'
	),
	subscription_effect_last_error = json_extract(
		detail_json,
		'$.subscriptionEffectLastError'
	),
	updated_at = created_at
WHERE provider IN (
	'cloudflare-email-routing',
	'cloudflare-email-routing-dedupe'
);

UPDATE email_delivery_events
SET updated_at = created_at
WHERE updated_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_email_delivery_events_user_state_created
ON email_delivery_events(user_id, state, created_at, id)
WHERE provider = 'cloudflare-email-routing' AND state IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_email_delivery_events_user_dedupe_expires
ON email_delivery_events(user_id, dedupe_expires_at, id)
WHERE provider = 'cloudflare-email-routing-dedupe'
	AND dedupe_expires_at IS NOT NULL;

-- Cross-store idempotency for the external D1 rollup effect. Mailbox owns the
-- effect state/lease; this ledger only prevents replay from incrementing the
-- aggregate twice if the Worker fails after D1 commit but before Mailbox CAS.
CREATE TABLE email_inbound_usage_effects (
	user_id TEXT NOT NULL,
	delivery_id TEXT NOT NULL,
	finalization_token TEXT NOT NULL,
	created_at TEXT NOT NULL,
	PRIMARY KEY (user_id, delivery_id, finalization_token),
	FOREIGN KEY (delivery_id) REFERENCES email_delivery_events(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_email_inbound_usage_effects_delivery
ON email_inbound_usage_effects(delivery_id);
