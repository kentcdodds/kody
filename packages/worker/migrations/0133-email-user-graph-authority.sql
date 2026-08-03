-- Step 5 USER graph authority cutover.
--
-- The migration is intentionally fail-closed. Every owner present in the
-- frozen shared USER graph must have a fresh, successful, complete Mailbox
-- parity record before this deployment can enable Mailbox-only writes. This
-- preserves the retired production read-cutover eligibility exactly: at least
-- two hours of continuous matching, a check within six hours, completed
-- creation backfills, and no active content-replay window/cursor. The migration
-- excludes only `system:email`: a frozen USER owner with `deleting_at` set
-- intentionally blocks deployment until account-deletion cleanup completes, at
-- which point operators retry this migration.
CREATE TABLE migration_0133_email_user_graph_authority_guard (
	value INTEGER NOT NULL CHECK (value = 1)
);

INSERT INTO migration_0133_email_user_graph_authority_guard (value)
WITH frozen_owners(user_id) AS (
	SELECT user_id FROM email_threads WHERE user_id != 'system:email'
	UNION
	SELECT user_id FROM email_messages WHERE user_id != 'system:email'
	UNION
	SELECT user_id FROM email_delivery_events WHERE user_id != 'system:email'
),
cutover_clock(now_jd, matching_since_min_jd, checked_at_min_jd) AS (
	SELECT
		julianday('now'),
		julianday('now', '-2 hours'),
		julianday('now', '-6 hours')
)
-- `julianday` compares instants rather than timestamp spellings. Its NULL
-- result for malformed input is rejected explicitly below, as is SQL NULL.
SELECT CASE WHEN COUNT(*) = 0 THEN 1 ELSE 0 END
FROM frozen_owners AS owner
LEFT JOIN users AS user ON user.stable_user_id = owner.user_id
CROSS JOIN cutover_clock AS clock
WHERE user.id IS NULL
	OR user.deleting_at IS NOT NULL
	OR user.mailbox_parity_matching_since IS NULL
	OR julianday(user.mailbox_parity_matching_since) IS NULL
	OR julianday(user.mailbox_parity_matching_since) >
		clock.matching_since_min_jd
	OR julianday(user.mailbox_parity_matching_since) > clock.now_jd
	OR user.mailbox_parity_mismatch_count != 0
	OR user.mailbox_parity_last_error IS NOT NULL
	OR user.mailbox_parity_content_watermark_at IS NULL
	OR user.mailbox_parity_content_replay_upper_at IS NOT NULL
	OR user.mailbox_parity_content_replay_cursor_updated_at IS NOT NULL
	OR user.mailbox_parity_content_replay_cursor_id IS NOT NULL
	OR user.mailbox_parity_message_backfill_completed_at IS NULL
	OR user.mailbox_parity_event_backfill_completed_at IS NULL
	OR user.mailbox_parity_checked_at IS NULL
	OR julianday(user.mailbox_parity_checked_at) IS NULL
	OR julianday(user.mailbox_parity_checked_at) < clock.checked_at_min_jd
	OR julianday(user.mailbox_parity_checked_at) > clock.now_jd;

DROP TABLE migration_0133_email_user_graph_authority_guard;

CREATE TABLE email_user_graph_authority (
	singleton INTEGER PRIMARY KEY NOT NULL CHECK (singleton = 1),
	owner_count INTEGER NOT NULL CHECK (owner_count >= 0),
	frozen_at TEXT NOT NULL,
	max_parity_age_hours INTEGER NOT NULL CHECK (max_parity_age_hours = 6)
);

INSERT INTO email_user_graph_authority (
	singleton,
	owner_count,
	frozen_at,
	max_parity_age_hours
)
WITH frozen_owners(user_id) AS (
	SELECT user_id FROM email_threads WHERE user_id != 'system:email'
	UNION
	SELECT user_id FROM email_messages WHERE user_id != 'system:email'
	UNION
	SELECT user_id FROM email_delivery_events WHERE user_id != 'system:email'
)
SELECT 1, COUNT(*), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), 6
FROM frozen_owners;

-- Thin USER inbound coordination index. It carries no message/event payload;
-- the scheduled Worker uses it only to discover owner Mailboxes with due work.
CREATE TABLE email_inbound_due_owners (
	user_id TEXT PRIMARY KEY NOT NULL CHECK (user_id != 'system:email'),
	due_at TEXT NOT NULL,
	reason TEXT NOT NULL,
	attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
	last_error TEXT,
	updated_at TEXT NOT NULL
);

CREATE INDEX idx_email_inbound_due_owners_priority_due_at
	ON email_inbound_due_owners(
		CASE WHEN reason = 'cutover-audit' THEN 1 ELSE 0 END,
		due_at,
		user_id
	);

-- Audit every frozen owner once after cutover. The bounded scheduled sweeper
-- opens each Mailbox, processes stale/effect work, then replaces or removes
-- this row from the owner-local due hint.
INSERT INTO email_inbound_due_owners (
	user_id,
	due_at,
	reason,
	attempt_count,
	last_error,
	updated_at
)
WITH frozen_owners(user_id) AS (
	SELECT user_id FROM email_threads WHERE user_id != 'system:email'
	UNION
	SELECT user_id FROM email_messages WHERE user_id != 'system:email'
	UNION
	SELECT user_id FROM email_delivery_events WHERE user_id != 'system:email'
),
cutover_clock(now_at) AS (
	SELECT strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
)
SELECT owner.user_id, clock.now_at, 'cutover-audit', 0, NULL, clock.now_at
FROM frozen_owners AS owner
CROSS JOIN cutover_clock AS clock;

-- Aggregate-only coordination for operator visibility into owner-local
-- provider-index repair ledgers. No provider or message identifiers live here.
CREATE TABLE email_outbound_provider_index_repair_owners (
	user_id TEXT PRIMARY KEY NOT NULL CHECK (user_id != 'system:email'),
	pending_count INTEGER NOT NULL CHECK (pending_count > 0),
	oldest_pending_at TEXT NOT NULL,
	updated_at TEXT NOT NULL
);

CREATE INDEX idx_email_outbound_provider_index_repair_owners_oldest
	ON email_outbound_provider_index_repair_owners(oldest_pending_at, user_id);

-- Thin provider lifecycle alert signal. No message id, address, subject, body,
-- or other USER graph payload is retained here.
CREATE TABLE email_delivery_alert_events (
	provider_event_id TEXT PRIMARY KEY NOT NULL,
	provider TEXT NOT NULL,
	event_type TEXT NOT NULL CHECK (event_type IN ('bounced', 'complained')),
	occurred_at TEXT NOT NULL,
	owner_hash TEXT,
	created_at TEXT NOT NULL
);

CREATE INDEX idx_email_delivery_alert_events_occurred_at
	ON email_delivery_alert_events(occurred_at, provider_event_id);
