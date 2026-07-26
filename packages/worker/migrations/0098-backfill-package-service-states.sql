-- One-time rescue of package services that only survive in run history.
--
-- `package_service_states` (0095) is written on service lifecycle transitions
-- and heartbeated while running, so it only gains a row once a
-- `PackageServiceInstance` Durable Object wakes. A service that stopped before
-- the run-records migration and never woke again therefore has no row, and is
-- reachable only through `package_runtime_runs` — which stopped being written
-- and drains under the 30-day retention policy.
--
-- Account deletion enumerates services to purge their Durable Objects, so
-- losing that record would leave service state alive after an account is
-- deleted. This backfill is the last opportunity to capture them, and it is
-- what lets the legacy `package_runtime_runs` read be removed.
--
-- Rescued rows are recorded as `stopped`: these services have not run in
-- weeks, `stopped` is the honest status, and it keeps them out of the running
-- count that enforces the concurrency entitlement. `updated_at` carries the
-- last observed run so staleness handling stays accurate.

INSERT OR IGNORE INTO package_service_states (
	user_id, package_id, service_name, status, started_at, updated_at
)
SELECT
	user_id,
	package_id,
	name,
	'stopped',
	NULL,
	MAX(started_at)
FROM package_runtime_runs
WHERE surface = 'service'
	AND name IS NOT NULL
	AND trim(name) != ''
GROUP BY user_id, package_id, name;
