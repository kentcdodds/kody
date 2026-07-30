-- Local-dev/test sink for feature-flag success-metric exposures.
--
-- In production/preview, exposures are written only to the FLAG_EXPOSURES
-- Analytics Engine dataset (see
-- packages/worker/src/feature-flags/exposure.ts). This table is the fallback
-- sink when that binding is absent (local dev, tests) so the admin metric
-- readout keeps working without Analytics Engine access. user_id holds the
-- stable user id so exposure rows join with usage_rollups.user_id.
CREATE TABLE IF NOT EXISTS feature_flag_exposure_rollups (
	flag_key TEXT NOT NULL,
	user_id TEXT NOT NULL,
	day TEXT NOT NULL,
	enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
	source TEXT NOT NULL,
	exposure_count INTEGER NOT NULL DEFAULT 0,
	updated_at TEXT NOT NULL,
	PRIMARY KEY (flag_key, user_id, day, enabled, source)
);

CREATE INDEX IF NOT EXISTS idx_feature_flag_exposure_rollups_user_id
	ON feature_flag_exposure_rollups (user_id);

-- Retention prunes select and order by day (see retention.ts); the composite
-- primary key starts with flag_key so it cannot serve that scan.
CREATE INDEX IF NOT EXISTS idx_feature_flag_exposure_rollups_day
	ON feature_flag_exposure_rollups (day);
