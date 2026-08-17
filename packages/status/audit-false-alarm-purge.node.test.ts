import { DatabaseSync } from 'node:sqlite'
import { expect, test } from 'vitest'
import { purgeAuditDbFalseAlarmData } from './audit-false-alarm-purge.ts'

test('purge removes only audit_db false incidents and failed samples', () => {
	const db = new DatabaseSync(':memory:')
	db.exec(`
		CREATE TABLE incidents (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			component TEXT NOT NULL,
			started_at INTEGER NOT NULL,
			resolved_at INTEGER,
			detail TEXT
		);
		CREATE TABLE samples (
			component TEXT NOT NULL,
			checked_at INTEGER NOT NULL,
			ok INTEGER NOT NULL,
			latency_ms INTEGER,
			detail TEXT
		);
		CREATE TABLE daily_stats (
			component TEXT NOT NULL,
			day TEXT NOT NULL,
			total INTEGER NOT NULL,
			failed INTEGER NOT NULL,
			PRIMARY KEY (component, day)
		);
		CREATE TABLE component_state (
			component TEXT PRIMARY KEY,
			status TEXT NOT NULL,
			consecutive_failures INTEGER NOT NULL,
			consecutive_successes INTEGER NOT NULL
		);
	`)
	db.exec(`
		INSERT INTO incidents (component, started_at, resolved_at, detail)
		VALUES
			('audit_db', 1, 2, 'timeout'),
			('app_db', 3, NULL, 'timeout');
		INSERT INTO samples (component, checked_at, ok, latency_ms, detail)
		VALUES
			('audit_db', 10, 0, 3000, 'timeout'),
			('audit_db', 11, 1, 80, NULL),
			('app_db', 12, 0, 200, 'error');
		INSERT INTO daily_stats (component, day, total, failed)
		VALUES
			('audit_db', '2026-08-17', 104, 13),
			('app_db', '2026-08-17', 104, 0);
		INSERT INTO component_state
			(component, status, consecutive_failures, consecutive_successes)
		VALUES
			('audit_db', 'down', 2, 0),
			('app_db', 'operational', 0, 4);
	`)

	purgeAuditDbFalseAlarmData((query, ...bindings) => {
		db.prepare(query).run(...bindings)
	})

	expect(
		db
			.prepare(`SELECT component FROM incidents ORDER BY id`)
			.all()
			.map((row) => row.component),
	).toEqual(['app_db'])
	expect(
		db.prepare(`SELECT component, ok FROM samples ORDER BY checked_at`).all(),
	).toEqual([
		{ component: 'audit_db', ok: 1 },
		{ component: 'app_db', ok: 0 },
	])
	expect(
		db
			.prepare(`SELECT component, failed FROM daily_stats ORDER BY component`)
			.all(),
	).toEqual([
		{ component: 'app_db', failed: 0 },
		{ component: 'audit_db', failed: 0 },
	])
	expect(
		db
			.prepare(
				`SELECT component, status, consecutive_failures
				FROM component_state ORDER BY component`,
			)
			.all(),
	).toEqual([
		{ component: 'app_db', status: 'operational', consecutive_failures: 0 },
		{ component: 'audit_db', status: 'operational', consecutive_failures: 0 },
	])
})
