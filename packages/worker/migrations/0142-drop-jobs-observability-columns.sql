-- RunLog is the sole authority for job error, duration, and outcome counters.
-- Keep the D1 scheduling/retention anchors last_run_at and last_run_status.

ALTER TABLE jobs DROP COLUMN last_run_error;
ALTER TABLE jobs DROP COLUMN last_duration_ms;
ALTER TABLE jobs DROP COLUMN run_count;
ALTER TABLE jobs DROP COLUMN success_count;
ALTER TABLE jobs DROP COLUMN error_count;
