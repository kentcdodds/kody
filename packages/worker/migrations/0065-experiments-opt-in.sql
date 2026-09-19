-- Account Experiments opt-in preference, plus an audience gate on feature
-- flags so operators can limit a flag to users who opted in at
-- /account/experiments.

ALTER TABLE users ADD COLUMN experiments_opt_in INTEGER NOT NULL DEFAULT 0
	CHECK (experiments_opt_in IN (0, 1));

ALTER TABLE feature_flags ADD COLUMN audience TEXT NOT NULL DEFAULT 'everyone'
	CHECK (audience IN ('everyone', 'experiments_opt_in'));
