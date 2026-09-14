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

/**
 * Wrangler 4.131+ builds the local sqlite-class map during a real `deploy`
 * (container validation runs even when the worker has no containers) and
 * still ignores `transferred_classes`. A production chain that transfers a
 * class and later deletes it therefore fails before upload.
 *
 * Copy each later-deleted transfer `to` into that step's `new_sqlite_classes`
 * so the local map can see the class. Keep `transferred_classes` and the
 * delete tag so `getMigrationsToUpload` still matches Cloudflare's applied
 * tags. Do not use `localizeMigrations` for a real deploy: dropping `v2`
 * would make wrangler treat production's current tag as missing and replay
 * the chain.
 */
export function annotateTransfersForLocalSqliteMap(
	migrations: unknown,
): unknown {
	if (!Array.isArray(migrations)) return migrations

	const deleted = new Set<string>()
	for (const migration of migrations) {
		if (!migration || typeof migration !== 'object') continue
		const classes = (migration as JsonRecord).deleted_classes
		if (!Array.isArray(classes)) continue
		for (const name of classes) {
			if (typeof name === 'string') deleted.add(name)
		}
	}
	if (deleted.size === 0) return migrations

	return migrations.map((migration) => {
		if (!migration || typeof migration !== 'object') return migration
		const record = { ...(migration as JsonRecord) }
		const transferred = record.transferred_classes
		if (!Array.isArray(transferred)) return record
		const existing = Array.isArray(record.new_sqlite_classes)
			? (record.new_sqlite_classes as Array<unknown>).filter(
					(name): name is string => typeof name === 'string',
				)
			: []
		const seen = new Set(existing)
		const created = transferred
			.map((entry) =>
				entry && typeof entry === 'object'
					? (entry as JsonRecord).to
					: undefined,
			)
			.filter((name): name is string => typeof name === 'string')
			.filter((name) => deleted.has(name) && !seen.has(name))
		if (created.length === 0) return record
		record.new_sqlite_classes = [...existing, ...created]
		return record
	})
}
