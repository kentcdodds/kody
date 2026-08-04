-- Drop quiescent D1 run-projection mirrors after RunLog became authoritative.
-- workflow_runs retention, account deletion/export targets, and durable
-- activation counters are detached in application guardrails before this runs.

DROP TABLE IF EXISTS workflow_runs;
DROP TABLE IF EXISTS user_package_run_successes;
DROP TABLE IF EXISTS user_activation_milestones;
