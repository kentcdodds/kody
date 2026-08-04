-- Final RunLog contract boundary (migration-only). Drops the quiescent D1
-- projection tables after the RunLog authority application deploy. Operators
-- must not manufacture SQL approval rows for this cutover; production gates
-- are documented in migration comments and architecture docs instead.
--
-- Production gates (verified before this migration may ship):
-- - Application cutover deployed:
--   https://github.com/kentcdodds/kody/actions/runs/30876391371
-- - RunLog parity: 41/41 non-deleting users, 9 keyset pages, zero failed,
--   missing, or undercount rows (2026-08-04 02:45–02:46 UTC)
-- - Post-cutover production smoke: workflow_run_list succeeded
-- - Pre-drop D1 Time Travel bookmark for database
--   8c1014d1-6b41-4695-a0a2-159071f0f919:
--   0000116d-000000d2-000050bd-c7ecd5892a189df7cda145af746bc9c9
--
-- Restore rationale: authoritative workflow, activation, and package-success
-- state lives in per-user RunLog dedicated tables. These D1 mirrors are not
-- read or written on any runtime path after the application deploy. If this
-- migration must be rolled back, restore the three tables from the bookmark
-- above (or a fresher Time Travel snapshot taken immediately before apply)
-- rather than reintroducing dual-write paths.
--
-- Account deletion/export inventories and the hourly D1 workflow_runs
-- retention lane were already detached by the preceding code-only deploy
-- (PR #1206).

DROP INDEX IF EXISTS idx_workflow_runs_status_updated_at;
DROP INDEX IF EXISTS workflow_runs_user_idempotency_idx;
DROP INDEX IF EXISTS workflow_runs_user_created_idx;
DROP INDEX IF EXISTS workflow_runs_user_active_idx;
DROP INDEX IF EXISTS idx_user_activation_milestones_milestone_reached;

DROP TABLE IF EXISTS workflow_runs;
DROP TABLE IF EXISTS user_package_run_successes;
DROP TABLE IF EXISTS user_activation_milestones;
