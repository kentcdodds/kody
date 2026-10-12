-- The unattached job lane is gone (ADR 0032). Package jobs do not read
-- `jobs.preserved` or `archived_job_artifacts`. Drop the retention index
-- before the column: SQLite refuses to drop an indexed column.
-- Production 2026-10-12: archived_job_artifacts has 0 rows. Six package
-- jobs still have preserved = 1; dropping the column discards that unused
-- flag. Do not edit 0001–0004.

DROP INDEX IF EXISTS idx_jobs_retention_candidates;

ALTER TABLE jobs DROP COLUMN preserved;

DROP TABLE IF EXISTS archived_job_artifacts;
