-- Activation funnel storage.
--
-- Most funnel steps are already derivable from durable tables: signup and
-- verification from `users`, agent connection from `mcp_agent_sessions`, and
-- first fork from `community_forks`. Two things are not, and this migration
-- adds exactly those.
--
-- 1. `community_forks.actor` — a fork created by a person clicking install in
--    the web app and a fork created by that person's agent over MCP are the
--    same row today. They are not the same activation signal, and conflating
--    them lets agent-driven activity inflate the funnel. Existing rows stay
--    NULL because their origin is genuinely unknown.
--
-- 2. `user_activation_milestones` — run-derived milestones. Activation is
--    defined as a forked package that has run successfully at least twice,
--    but `package_runtime_runs` is retention-pruned (see
--    packages/worker/src/app/retention.ts), so the funnel cannot be
--    reconstructed from run history after the fact. Milestones are therefore
--    written once, when reached, and never updated.

ALTER TABLE community_forks ADD COLUMN actor TEXT
CHECK (actor IS NULL OR actor IN ('human', 'agent'));

CREATE TABLE user_activation_milestones (
	user_id TEXT NOT NULL,
	milestone TEXT NOT NULL CHECK (
		milestone IN ('package_run_succeeded', 'package_activated')
	),
	reached_at TEXT NOT NULL,
	-- The package that reached the milestone. Kept so a later analysis can
	-- tell whether activation came from a forked package or an authored one.
	package_id TEXT,
	PRIMARY KEY (user_id, milestone)
);

CREATE INDEX idx_user_activation_milestones_milestone_reached
ON user_activation_milestones(milestone, reached_at);

-- Backfill from the runs that survive retention. This under-counts users whose
-- qualifying runs were already pruned; it cannot be better, and a partial
-- baseline beats none.
INSERT OR IGNORE INTO user_activation_milestones (
	user_id, milestone, reached_at, package_id
)
SELECT user_id, 'package_run_succeeded', MIN(started_at), NULL
FROM package_runtime_runs
WHERE status = 'success'
GROUP BY user_id;

INSERT OR IGNORE INTO user_activation_milestones (
	user_id, milestone, reached_at, package_id
)
SELECT user_id, 'package_activated', second_success_at, package_id
FROM (
	SELECT
		user_id,
		package_id,
		MIN(started_at) AS second_success_at,
		ROW_NUMBER() OVER (PARTITION BY user_id ORDER BY MIN(started_at)) AS rn
	FROM (
		SELECT
			user_id,
			package_id,
			started_at,
			ROW_NUMBER() OVER (
				PARTITION BY user_id, package_id ORDER BY started_at
			) AS success_rank
		FROM package_runtime_runs
		WHERE status = 'success'
	)
	WHERE success_rank = 2
	GROUP BY user_id, package_id
)
WHERE rn = 1;
