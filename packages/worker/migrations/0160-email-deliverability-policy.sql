-- Per-recipient send cooldowns after terminal delivery failures, observed
-- rejecting MX providers for holdable transactional mail, and an owner-clearable
-- outbound pause after consecutive user-mail delivery failures.

CREATE TABLE email_recipient_cooldowns (
	recipient TEXT PRIMARY KEY NOT NULL,
	class TEXT NOT NULL,
	reason TEXT,
	cooldown_until TEXT NOT NULL,
	last_failure_at TEXT NOT NULL,
	failure_count INTEGER NOT NULL DEFAULT 1,
	created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
	updated_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
);

CREATE INDEX idx_email_recipient_cooldowns_until
	ON email_recipient_cooldowns(cooldown_until);

CREATE TABLE email_rejecting_providers (
	provider_key TEXT PRIMARY KEY NOT NULL,
	last_rejection_at TEXT NOT NULL,
	rejection_count INTEGER NOT NULL DEFAULT 1,
	last_recipient_domain TEXT,
	seeded INTEGER NOT NULL DEFAULT 0,
	created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
	updated_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
);

CREATE INDEX idx_email_rejecting_providers_last_rejection
	ON email_rejecting_providers(last_rejection_at);

-- Fallback seed while observed blocklist rejections catch up. Rows expire when
-- last_rejection_at ages past the rejecting-provider TTL with no refresh.
-- ISO-8601 UTC timestamps so lexicographic compares against
-- Date.toISOString() cutoffs keep the full rejecting-provider TTL
-- (SQLite CURRENT_TIMESTAMP uses a space before the time and sorts
-- before same-day ISO cutoffs, which would drop the seed at midnight).
INSERT INTO email_rejecting_providers (
	provider_key,
	last_rejection_at,
	rejection_count,
	last_recipient_domain,
	seeded,
	created_at,
	updated_at
) VALUES
	(
		'messagingengine.com',
		printf('%sT%sZ', date('now'), time('now')),
		1,
		NULL,
		1,
		printf('%sT%sZ', date('now'), time('now')),
		printf('%sT%sZ', date('now'), time('now'))
	),
	(
		'simplelogin.co',
		printf('%sT%sZ', date('now'), time('now')),
		1,
		NULL,
		1,
		printf('%sT%sZ', date('now'), time('now')),
		printf('%sT%sZ', date('now'), time('now'))
	);

CREATE TABLE email_mx_lookup_cache (
	domain TEXT PRIMARY KEY NOT NULL,
	provider_keys_json TEXT NOT NULL,
	mx_hosts_json TEXT NOT NULL,
	looked_up_at TEXT NOT NULL,
	expires_at TEXT NOT NULL
);

CREATE INDEX idx_email_mx_lookup_cache_expires
	ON email_mx_lookup_cache(expires_at);

ALTER TABLE orgs ADD COLUMN email_outbound_delivery_paused_at TEXT;
ALTER TABLE orgs ADD COLUMN email_outbound_consecutive_failures INTEGER NOT NULL DEFAULT 0;
