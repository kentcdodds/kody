type JsonRecord = Record<string, unknown>

/**
 * Already-applied `kody-runtime` deletes. Production is at tag `v2`; only
 * these names may be stripped from a real-deploy rewrite. A later live-class
 * `deleted_classes` tag must stay so Cloudflare still applies it.
 */
export const alreadyAppliedRuntimeDeletedClasses = [
	'PackageServiceInstance',
] as const

/**
 * Strip an allowlisted set of already-applied deletes, without converting
 * transfers or dropping tags.
 *
 * Wrangler 4.131+ walks the local sqlite-class map on real `wrangler deploy`,
 * not only `--dry-run`. That map ignores `transferred_classes`, so a
 * transfer-then-delete of `PackageServiceInstance` throws before upload.
 * Keep every tag (including an empty `v2`) so last-tag matching still works.
 * Pass only classes whose delete has already landed; stripping a pending
 * delete would advance the last-applied tag and leave the class in place.
 */
export function elideDeletedMigrationClasses(
	migrations: unknown,
	classes: ReadonlyArray<string> = alreadyAppliedRuntimeDeletedClasses,
): unknown {
	if (!Array.isArray(migrations)) return migrations

	const allow = new Set(classes)
	const deleted = new Set(
		[...collectDeletedClassNames(migrations)].filter((name) => allow.has(name)),
	)
	return migrations.map((migration) => {
		if (!migration || typeof migration !== 'object') return migration
		const record = { ...(migration as JsonRecord) }
		stripTransferredClasses(record, deleted)
		stripDeletedClasses(record, 'new_sqlite_classes', deleted)
		stripDeletedClasses(record, 'new_classes', deleted)
		stripDeletedClasses(record, 'deleted_classes', deleted)
		return record
	})
}

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
 * script no longer exports the class. Empty tags are dropped; use
 * `elideDeletedMigrationClasses` when a remote last-applied tag must stay.
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

	const deleted = collectDeletedClassNames(converted)

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

function collectDeletedClassNames(migrations: ReadonlyArray<unknown>) {
	const deleted = new Set<string>()
	for (const migration of migrations) {
		if (!migration || typeof migration !== 'object') continue
		const classes = (migration as JsonRecord).deleted_classes
		if (!Array.isArray(classes)) continue
		for (const name of classes) {
			if (typeof name === 'string') deleted.add(name)
		}
	}
	return deleted
}

function stripTransferredClasses(
	record: JsonRecord,
	deleted: ReadonlySet<string>,
) {
	const transferred = record.transferred_classes
	if (!Array.isArray(transferred)) return
	const kept = transferred.filter((entry) => {
		if (!entry || typeof entry !== 'object') return true
		const to = (entry as JsonRecord).to
		return typeof to !== 'string' || !deleted.has(to)
	})
	if (kept.length === 0) delete record.transferred_classes
	else record.transferred_classes = kept
}

function stripDeletedClasses(
	record: JsonRecord,
	key: 'new_sqlite_classes' | 'new_classes' | 'deleted_classes',
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
