type JsonRecord = Record<string, unknown>

/**
 * Rewrite a worker's Durable Object migrations for single-process local dev.
 *
 * Wrangler's local sqlite-class map (`getDurableObjectClassNameToUseSQLiteMap`)
 * ignores `transferred_classes`. A production chain that transfers a class in
 * and later deletes it therefore fails startup with "Cannot apply
 * deleted_classes migration to non-existent class". Locally every class is
 * new, so transfers become `new_sqlite_classes` (mirroring the committed
 * `preview` env chains). Classes that the same chain later deletes are
 * elided: creating them only to delete them trips the same check when the
 * script no longer exports the class.
 */
export function localizeMigrations(migrations: unknown): unknown {
	if (!Array.isArray(migrations)) return migrations

	const converted = migrations.map((migration) => {
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

	const deleted = new Set<string>()
	for (const migration of converted) {
		if (!migration || typeof migration !== 'object') continue
		const classes = (migration as JsonRecord).deleted_classes
		if (!Array.isArray(classes)) continue
		for (const name of classes) {
			if (typeof name === 'string') deleted.add(name)
		}
	}

	const localized: Array<unknown> = []
	for (const migration of converted) {
		if (!migration || typeof migration !== 'object') {
			localized.push(migration)
			continue
		}
		const record = { ...(migration as JsonRecord) }
		stripDeletedClasses(record, 'new_sqlite_classes', deleted)
		stripDeletedClasses(record, 'deleted_classes', deleted)
		if (!migrationHasOps(record)) continue
		localized.push(record)
	}
	return localized
}

function stripDeletedClasses(
	record: JsonRecord,
	key: 'new_sqlite_classes' | 'deleted_classes',
	deleted: ReadonlySet<string>,
) {
	const classes = record[key]
	if (!Array.isArray(classes)) return
	const kept = classes.filter(
		(name) => typeof name !== 'string' || !deleted.has(name),
	)
	if (kept.length === 0) delete record[key]
	else record[key] = kept
}

function migrationHasOps(record: JsonRecord) {
	return (
		hasEntries(record.new_sqlite_classes) ||
		hasEntries(record.new_classes) ||
		hasEntries(record.deleted_classes) ||
		hasEntries(record.renamed_classes) ||
		hasEntries(record.transferred_classes)
	)
}

function hasEntries(value: unknown) {
	return Array.isArray(value) && value.length > 0
}
