-- Org job-retention prefs are unused. The product UI and actions were
-- removed with the unattached job lane. Dropping these columns discards
-- the values still stored on two production orgs (14 / 60 / 90 days).
-- The app no longer reads them. Do not edit 0001 or 0086.

ALTER TABLE orgs DROP COLUMN job_retention_success_once_days;
ALTER TABLE orgs DROP COLUMN job_retention_failed_once_days;
ALTER TABLE orgs DROP COLUMN job_retention_disabled_recurring_days;
