type JsonRecord = Record<string, unknown>

/**
 * Rewrite a worker's Durable Object migrations for single-process local dev.
 * Wrangler's local migration check ignores `transferred_classes`, so a chain
 * that transfers a class in from another script and later deletes it fails
 * startup. Locally every class is new, so transfers become
 * `new_sqlite_classes` (mirroring the committed `preview` env chains).
 */
export function localizeMigrations(migrations: unknown): unknown {
	if (!Array.isArray(migrations)) return migrations
	return migrations.map((migration) => {
		if (!migration || typeof migration !== 'object') return migration
		const record = { ...(migration as JsonRecord) }
		const transferred = record.transferred_classes
		if (!Array.isArray(transferred)) return record
		delete record.transferred_classes
		const created = transferred
			.map((entry) =>
				entry && typeof entry === 'object'
					? (entry as JsonRecord).to
					: undefined,
			)
			.filter((name): name is string => typeof name === 'string')
		const existing = Array.isArray(record.new_sqlite_classes)
			? (record.new_sqlite_classes as Array<unknown>)
			: []
		record.new_sqlite_classes = [...existing, ...created]
		return record
	})
}
