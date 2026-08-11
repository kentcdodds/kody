-- Jobs data moved to the dedicated jobs-worker D1 database (ADR 0016).
-- The rows were copied to `kody-jobs` and all reads/writes flipped to the
-- JOBS service binding before this drop (see
-- docs/contributing/architecture/jobs-worker-migration-runbook.md).
DROP TABLE IF EXISTS archived_job_artifacts;
DROP TABLE IF EXISTS jobs;
