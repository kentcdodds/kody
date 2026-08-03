import { readdirSync, readFileSync } from 'node:fs'
import { type DatabaseSync } from 'node:sqlite'

export const migrationsDirectory = new URL('../../migrations/', import.meta.url)
export const systemEmailGraphMigration = '0130-system-email-graph-expand.sql'
export const systemEmailAuthorityMigration =
	'0131-system-email-graph-authority.sql'

export function applyMigrationsBefore(
	db: DatabaseSync,
	exclusiveUpperBound: string,
) {
	for (const fileName of readdirSync(migrationsDirectory)
		.filter((file) => file.endsWith('.sql') && file < exclusiveUpperBound)
		.sort()) {
		db.exec(readFileSync(new URL(fileName, migrationsDirectory), 'utf8'))
	}
}

/**
 * Wrangler applies one migration file and its ledger insert in one D1
 * multi-statement transaction. This helper preserves that rollback boundary.
 */
export function applyMigrationLikeD1(db: DatabaseSync, fileName: string) {
	const sql = readFileSync(new URL(fileName, migrationsDirectory), 'utf8')
	db.exec('BEGIN')
	try {
		db.exec(sql)
		db.exec('COMMIT')
	} catch (error) {
		db.exec('ROLLBACK')
		throw error
	}
}
