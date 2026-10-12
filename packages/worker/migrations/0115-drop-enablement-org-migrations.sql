-- The enablement org migration ledger is unused. #3388 removed the legacy
-- trigger lane, so a missing row no longer changes how an org runs. The table
-- was only read by the backfill this change deletes. New personal orgs never
-- received a row, so a count of orgs without a migrated row could not reach 0.
-- Every org created before 2026-10-11T09:51Z (#3388) already has a migrated
-- row or has zero triggers. The primary-key index drops with the table.
-- Do not edit 0106.

DROP TABLE IF EXISTS enablement_org_migrations;
