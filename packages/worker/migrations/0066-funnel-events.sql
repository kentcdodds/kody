-- Onboarding funnel mirror and first-event claims.
-- Analytics Engine `kody_funnel_events` is the production stream. These rows
-- keep local admin counts working and let account deletion drop user-keyed
-- points. `user_id` is the stable user id, or empty for pre-auth signup starts.

CREATE TABLE funnel_events (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	event TEXT NOT NULL,
	user_id TEXT NOT NULL DEFAULT '',
	occurred_at TEXT NOT NULL,
	client_family TEXT NOT NULL DEFAULT '',
	error_class TEXT NOT NULL DEFAULT '',
	plan TEXT NOT NULL DEFAULT '',
	card_id TEXT NOT NULL DEFAULT ''
);

CREATE INDEX idx_funnel_events_occurred_event
	ON funnel_events(occurred_at, event);

CREATE TABLE funnel_first_claims (
	user_id TEXT NOT NULL,
	event TEXT NOT NULL,
	claimed_at TEXT NOT NULL,
	PRIMARY KEY (user_id, event)
);
