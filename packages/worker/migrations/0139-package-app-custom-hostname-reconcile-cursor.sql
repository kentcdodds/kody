-- Singleton keyset cursor for the package_app_custom_hostnames_reconcile
-- scheduled lane. Persists last scanned id across cron ticks so a 60s budget
-- cannot starve later rows (ADR 0071 grace-period cleanup).

CREATE TABLE package_app_custom_hostname_reconcile_cursor (
	singleton INTEGER PRIMARY KEY NOT NULL CHECK (singleton = 1),
	after_id TEXT NOT NULL DEFAULT '',
	updated_at TEXT NOT NULL
);

INSERT INTO package_app_custom_hostname_reconcile_cursor (singleton, after_id, updated_at)
VALUES (1, '', datetime('now'));
