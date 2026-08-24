-- Fleet-wide UTC-day execute counts for the homepage ticker.
-- Platform-owned (no user_id): not an account export/deletion target.
-- Hourly AE sync rewrites days in the current and previous UTC months;
-- the public payload uses only completed days (through yesterday).
CREATE TABLE fleet_execute_days (
	day TEXT PRIMARY KEY NOT NULL,
	event_count INTEGER NOT NULL,
	updated_at TEXT NOT NULL
);
