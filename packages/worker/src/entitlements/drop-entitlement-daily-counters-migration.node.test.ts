import { readdirSync, readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { expect, test } from 'vitest'

const migrationsDirectory = new URL('../../migrations/', import.meta.url)

const createEntitlementDailyCountersMigration =
	'0048-user-plans-and-entitlement-counters.sql'
const retentionIndexesMigration = '0055-retention-indexes.sql'
const dropEntitlementDailyCountersMigration =
	'0126-drop-entitlement-daily-counters.sql'

function migrationFileNames() {
	return readdirSync(migrationsDirectory)
		.filter((file) => file.endsWith('.sql'))
		.sort()
}

function applyMigration(db: DatabaseSync, fileName: string) {
	db.exec(readFileSync(new URL(fileName, migrationsDirectory), 'utf8'))
}

function applyMigrationsThrough(
	db: DatabaseSync,
	inclusiveUpperBound: string,
	exclusiveLowerBound = '',
) {
	for (const fileName of migrationFileNames().filter(
		(file) => file > exclusiveLowerBound && file <= inclusiveUpperBound,
	)) {
		applyMigration(db, fileName)
	}
}

function schemaObjectPresent(
	db: DatabaseSync,
	type: 'table' | 'index',
	name: string,
) {
	return (
		db
			.prepare(
				`SELECT 1 AS present
				FROM sqlite_schema
				WHERE type = ? AND name = ?`,
			)
			.get(type, name) as { present: number } | undefined
	)?.present
}

test('0048 creates entitlement_daily_counters, 0055 indexes it, and 0126 drops both', () => {
	const db = new DatabaseSync(':memory:')
	db.exec('PRAGMA foreign_keys = ON')

	applyMigrationsThrough(db, createEntitlementDailyCountersMigration)
	expect(schemaObjectPresent(db, 'table', 'entitlement_daily_counters')).toBe(1)
	expect(
		schemaObjectPresent(db, 'index', 'idx_entitlement_daily_counters_day'),
	).toBeUndefined()

	applyMigrationsThrough(
		db,
		retentionIndexesMigration,
		createEntitlementDailyCountersMigration,
	)
	expect(schemaObjectPresent(db, 'table', 'entitlement_daily_counters')).toBe(1)
	expect(
		schemaObjectPresent(db, 'index', 'idx_entitlement_daily_counters_day'),
	).toBe(1)

	applyMigration(db, dropEntitlementDailyCountersMigration)
	expect(
		schemaObjectPresent(db, 'table', 'entitlement_daily_counters'),
	).toBeUndefined()
	expect(
		schemaObjectPresent(db, 'index', 'idx_entitlement_daily_counters_day'),
	).toBeUndefined()
})
