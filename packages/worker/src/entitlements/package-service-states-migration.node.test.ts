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

test('backfill migration is a no-op when no legacy service runs exist', () => {
	const db = new DatabaseSync(':memory:')
	applyMigrationsBefore(db, backfillMigration)

	db.exec(`
		INSERT INTO package_service_states (
			user_id, package_id, service_name, status, started_at, updated_at
		) VALUES (
			'user-a', 'pkg-3', 'live-service', 'running',
			'2026-07-26T00:00:00.000Z', '2026-07-26T01:00:00.000Z'
		);
	`)

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
			package_id: 'pkg-3',
			service_name: 'live-service',
			status: 'running',
			started_at: '2026-07-26T00:00:00.000Z',
			updated_at: '2026-07-26T01:00:00.000Z',
		},
	])
})
