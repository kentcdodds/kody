-- Close the pre-launch account-write-lease and feature-flag cleanup.
--
-- UserMeter has been the sole write-lease authority since 2026-08-03. The D1
-- lease table has no runtime readers or writers; account_write_lease_repairs
-- remains the live admin-repair audit log.

DROP INDEX IF EXISTS idx_account_write_leases_active_user;
DROP TABLE IF EXISTS account_write_leases;

-- These rollout flags are absent from the code registry. Remove overrides
-- before their parent rows so the cleanup is valid with foreign keys enabled.
DELETE FROM feature_flag_user_overrides
WHERE flag_key IN ('execute-pre-exec-typecheck', 'mailbox-read-cutover');

DELETE FROM feature_flags
WHERE key IN ('execute-pre-exec-typecheck', 'mailbox-read-cutover');
