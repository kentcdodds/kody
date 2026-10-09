import { softDeleteTables } from './tables.ts'

/**
 * Workers-unit D1 does not apply migrations. Add `deleted_at` to tables that
 * production code filters with liveDeletedAtSql.
 */
export async function ensureSoftDeleteTestColumns(
	db: D1Database,
	tables: ReadonlyArray<string> = softDeleteTables,
) {
	for (const table of tables) {
		try {
			await db.prepare(`ALTER TABLE ${table} ADD COLUMN deleted_at TEXT`).run()
		} catch {
			// Column already present on CREATE TABLE or a prior ensure call.
		}
	}
}
