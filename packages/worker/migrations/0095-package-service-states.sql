-- Authoritative per-service liveness for entitlement concurrency checks.
--
-- Package service status previously had to be inferred from
-- `package_runtime_runs` history rows. That is incorrect: history can leave a
-- stranded `running` row after a hard Durable Object eviction, and the runs
-- table is moving out of D1. This table is written on service lifecycle
-- transitions (and heartbeated while running) so quota enforcement reads real
-- current state.

CREATE TABLE IF NOT EXISTS package_service_states (
	user_id TEXT NOT NULL,
	package_id TEXT NOT NULL,
	service_name TEXT NOT NULL,
	status TEXT NOT NULL CHECK (status IN ('running', 'idle', 'stopped', 'error')),
	started_at TEXT,
	updated_at TEXT NOT NULL,
	PRIMARY KEY (user_id, package_id, service_name)
);

CREATE INDEX IF NOT EXISTS idx_package_service_states_user_status
ON package_service_states(user_id, status);
