-- Drop the last D1 leftovers of package-shaped run history.
--
-- `package_runtime_runs` / `package_runtime_logs` held per-package run and log
-- rows before RunLog owned history. `webhook_deliveries` held webhook delivery
-- rows before those were recorded as run records. `jobs.run_history_json` was
-- the older inline job-history blob.
--
-- Writers stopped using all of these in the RunLog migration; production data
-- that still mattered was rescued into `user_storage_buckets` (0097) and
-- `package_service_states` (0098). Nothing derives state from these leftovers
-- any more, so they are safe to drop.
--
-- Drop logs before runs (child before parent). D1 supports ALTER TABLE DROP
-- COLUMN in place for the unindexed `run_history_json` column.

DROP TABLE IF EXISTS package_runtime_logs;
DROP TABLE IF EXISTS package_runtime_runs;
DROP TABLE IF EXISTS webhook_deliveries;

ALTER TABLE jobs DROP COLUMN run_history_json;
