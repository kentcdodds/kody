-- Durable per-package success counters for the activation funnel.
--
-- Activation awards `package_activated` once any single package has succeeded
-- twice (see `user_activation_milestones` in 0094). That threshold used to be
-- counted from `package_runtime_runs`, which is retention-pruned and — after the
-- RunLog migration — no longer written. Counting history would permanently
-- stall the funnel.
--
-- This table is the durable counter: incremented on each qualifying successful
-- package-scoped finish, never pruned except by account deletion. Milestone
-- rows remain the terminal funnel signal; the counter only decides when to
-- write them.

CREATE TABLE user_package_run_successes (
	user_id TEXT NOT NULL,
	package_id TEXT NOT NULL,
	success_count INTEGER NOT NULL CHECK (success_count >= 0),
	updated_at TEXT NOT NULL,
	PRIMARY KEY (user_id, package_id)
);

-- Best-effort backfill from leftover history. Under-counts users whose
-- qualifying runs were already pruned; partial baseline beats none.
INSERT INTO user_package_run_successes (
	user_id, package_id, success_count, updated_at
)
SELECT
	user_id,
	package_id,
	COUNT(*),
	MAX(started_at)
FROM package_runtime_runs
WHERE status = 'success'
	AND package_id IS NOT NULL
GROUP BY user_id, package_id;
