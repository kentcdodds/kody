-- Teams P3 expand (JOBS_DB first): additive actor + soft-delete columns.
-- Ownership stays on user_id (the org id for migrated orgs). created_by_user_id
-- is provenance only and is backfilled from today's single owner.

ALTER TABLE jobs ADD COLUMN created_by_user_id TEXT;
ALTER TABLE jobs ADD COLUMN deleted_at TEXT;
ALTER TABLE jobs ADD COLUMN deleting_at TEXT;

ALTER TABLE archived_job_artifacts ADD COLUMN created_by_user_id TEXT;
ALTER TABLE archived_job_artifacts ADD COLUMN deleted_at TEXT;
ALTER TABLE archived_job_artifacts ADD COLUMN deleting_at TEXT;

UPDATE jobs
SET created_by_user_id = user_id
WHERE created_by_user_id IS NULL;

UPDATE archived_job_artifacts
SET created_by_user_id = user_id
WHERE created_by_user_id IS NULL;
