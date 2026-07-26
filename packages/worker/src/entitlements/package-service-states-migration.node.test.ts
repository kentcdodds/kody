import { readdirSync, readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { expect, test } from 'vitest'

const migrationsDirectory = new URL('../../migrations/', import.meta.url)
const backfillMigration = '0098-backfill-package-service-states.sql'

function applyMigrationsBefore(db: DatabaseSync, exclusiveUpperBound: string) {
	for (const fileName of readdirSync(migrationsDirectory)
		.filter((file) => file.endsWith('.sql') && file < exclusiveUpperBound)
		.sort()) {
		db.exec(readFileSync(new URL(fileName, migrationsDirectory), 'utf8'))
	}
}

function insertServiceRun(
	db: DatabaseSync,
	input: { id: string; packageId: string; name: string; startedAt: string },
) {
	db.exec(`
		INSERT INTO package_runtime_runs (
			id, user_id, package_id, package_kody_id, surface, status,
			started_at, created_at, updated_at, name
		) VALUES (
			'${input.id}', 'user-a', '${input.packageId}', 'kody-id', 'service',
			'success', '${input.startedAt}', '${input.startedAt}',
			'${input.startedAt}', '${input.name}'
		);
	`)
}

test('backfill rescues legacy-only services as stopped with their last run', () => {
	const db = new DatabaseSync(':memory:')
	applyMigrationsBefore(db, backfillMigration)

	// Two runs of the same service: the newest run wins as `updated_at`.
	insertServiceRun(db, {
		id: 'run-1',
		packageId: 'pkg-1',
		name: 'email-agent-processor',
		startedAt: '2026-05-30T14:24:06.316Z',
	})
	insertServiceRun(db, {
		id: 'run-2',
		packageId: 'pkg-1',
		name: 'email-agent-processor',
		startedAt: '2026-07-06T20:11:51.487Z',
	})
	insertServiceRun(db, {
		id: 'run-3',
		packageId: 'pkg-2',
		name: 'other-service',
		startedAt: '2026-06-01T00:00:00.000Z',
	})

	// A service that already projected real state must not be overwritten.
	db.exec(`
		INSERT INTO package_service_states (
			user_id, package_id, service_name, status, started_at, updated_at
		) VALUES (
			'user-a', 'pkg-3', 'live-service', 'running',
			'2026-07-26T00:00:00.000Z', '2026-07-26T01:00:00.000Z'
		);
	`)
	insertServiceRun(db, {
		id: 'run-4',
		packageId: 'pkg-3',
		name: 'live-service',
		startedAt: '2026-05-01T00:00:00.000Z',
	})

	db.exec(readFileSync(new URL(backfillMigration, migrationsDirectory), 'utf8'))

	const rows = db
		.prepare(
			`SELECT package_id, service_name, status, started_at, updated_at
			FROM package_service_states
			ORDER BY package_id ASC`,
		)
		.all() as Array<{
		package_id: string
		service_name: string
		status: string
		started_at: string | null
		updated_at: string
	}>

	expect(rows).toEqual([
		{
			package_id: 'pkg-1',
			service_name: 'email-agent-processor',
			status: 'stopped',
			started_at: null,
			updated_at: '2026-07-06T20:11:51.487Z',
		},
		{
			package_id: 'pkg-2',
			service_name: 'other-service',
			status: 'stopped',
			started_at: null,
			updated_at: '2026-06-01T00:00:00.000Z',
		},
		{
			package_id: 'pkg-3',
			service_name: 'live-service',
			status: 'running',
			started_at: '2026-07-26T00:00:00.000Z',
			updated_at: '2026-07-26T01:00:00.000Z',
		},
	])
})
