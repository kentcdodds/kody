-- Write-once first secret, integration, and job stamps for the onboarding
-- funnel. Analytics Engine records the event; these columns keep first_*
-- idempotent without reconstructing from usage logs.

ALTER TABLE users ADD COLUMN first_secret_at TEXT;
ALTER TABLE users ADD COLUMN first_integration_at TEXT;
ALTER TABLE users ADD COLUMN first_job_at TEXT;
