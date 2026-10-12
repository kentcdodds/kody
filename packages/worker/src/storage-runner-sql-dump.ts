/**
 * Copy a StorageRunner's SQL tables (package `packageStorage().sql(...)`
 * data) between Durable Objects. KV entries already move through
 * `exportStorage` / `importStorage`; those list only the KV API, so SQL tables
 * need their own dump. Kept free of Durable Object imports so node tests can
 * drive it over `node:sqlite`.
 */

export type StorageSqlValue = string | number | null | ArrayBuffer

export type StorageSqlCursorLike = {
	toArray(): Array<Record<string, StorageSqlValue>>
	readonly columnNames: Array<string>
}

export type StorageSqlExec = (
	query: string,
	...params: Array<StorageSqlValue>
) => StorageSqlCursorLike

export type StorageSqlSchemaObject = {
	type: 'table' | 'index' | 'trigger' | 'view'
	name: string
	tableName: string
	sql: string
	withoutRowid: boolean
}

export type StorageSqlRowsPage = {
	columns: Array<string>
	rows: Array<Array<StorageSqlValue>>
	/** Pass back as `cursor` for the next page; null when the table is done. */
	nextCursor: number | null
}

const schemaObjectOrder: Record<StorageSqlSchemaObject['type'], number> = {
	table: 0,
	index: 1,
	view: 2,
	trigger: 3,
}

const maxRowsPageSize = 500

function quoteIdentifier(name: string) {
	return `"${name.replaceAll('"', '""')}"`
}

function isUserSchemaObjectName(name: string) {
	return !name.startsWith('sqlite_') && !name.startsWith('_cf_')
}

/**
 * Shadow tables belong to a virtual table (FTS5 and friends): replaying the
 * virtual table recreates them, and copying its rows refills them.
 */
function readTableList(exec: StorageSqlExec) {
	const withoutRowid = new Set<string>()
	const shadow = new Set<string>()
	for (const row of exec(`PRAGMA table_list`).toArray()) {
		if (row.schema !== 'main') continue
		const name = String(row.name)
		if (row.type === 'shadow') shadow.add(name)
		if (row.type === 'table' && Number(row.wr) === 1) withoutRowid.add(name)
	}
	return { withoutRowid, shadow }
}

/** User-created SQL objects, tables first, so a replay creates them in order. */
export function readStorageSqlSchema(
	exec: StorageSqlExec,
): Array<StorageSqlSchemaObject> {
	const { withoutRowid, shadow } = readTableList(exec)
	const objects: Array<StorageSqlSchemaObject> = []
	for (const row of exec(
		`SELECT type, name, tbl_name, sql FROM sqlite_master WHERE sql IS NOT NULL`,
	).toArray()) {
		const type = String(row.type)
		const name = String(row.name)
		const tableName = String(row.tbl_name)
		if (
			type !== 'table' &&
			type !== 'index' &&
			type !== 'trigger' &&
			type !== 'view'
		) {
			continue
		}
		if (!isUserSchemaObjectName(name) || !isUserSchemaObjectName(tableName)) {
			continue
		}
		if (shadow.has(name) || shadow.has(tableName)) continue
		objects.push({
			type,
			name,
			tableName,
			sql: String(row.sql),
			withoutRowid: type === 'table' && withoutRowid.has(name),
		})
	}
	return objects.sort(
		(left, right) =>
			schemaObjectOrder[left.type] - schemaObjectOrder[right.type] ||
			left.name.localeCompare(right.name),
	)
}

function requireUserTable(exec: StorageSqlExec, table: string) {
	const object = readStorageSqlSchema(exec).find(
		(entry) => entry.type === 'table' && entry.name === table,
	)
	if (!object) {
		throw new Error(`Storage SQL table ${table} does not exist.`)
	}
	return object
}

/**
 * One page of a table's rows. Rowid tables page by rowid and keep it, so a
 * restore preserves INTEGER PRIMARY KEY values; WITHOUT ROWID tables page by
 * offset in primary-key order.
 */
export function readStorageSqlRowsPage(
	exec: StorageSqlExec,
	input: { table: string; cursor: number | null; pageSize?: number },
): StorageSqlRowsPage {
	const table = requireUserTable(exec, input.table)
	const pageSize = Math.min(
		Math.max(1, Math.trunc(input.pageSize ?? maxRowsPageSize)),
		maxRowsPageSize,
	)
	const quoted = quoteIdentifier(table.name)
	if (table.withoutRowid) {
		const offset = input.cursor ?? 0
		const cursor = exec(
			`SELECT * FROM ${quoted} LIMIT ? OFFSET ?`,
			pageSize + 1,
			offset,
		)
		const records = cursor.toArray()
		const columns = [...cursor.columnNames]
		const page = records.slice(0, pageSize)
		return {
			columns,
			rows: page.map((record) =>
				columns.map((column) => record[column] ?? null),
			),
			nextCursor: records.length > pageSize ? offset + pageSize : null,
		}
	}
	const cursor =
		input.cursor === null
			? exec(
					`SELECT rowid AS "__kody_rowid", * FROM ${quoted} ORDER BY rowid LIMIT ?`,
					pageSize + 1,
				)
			: exec(
					`SELECT rowid AS "__kody_rowid", * FROM ${quoted} WHERE rowid > ? ORDER BY rowid LIMIT ?`,
					input.cursor,
					pageSize + 1,
				)
	const records = cursor.toArray()
	const columns = cursor.columnNames.filter(
		(column) => column !== '__kody_rowid',
	)
	const page = records.slice(0, pageSize)
	const last = page.at(-1)
	return {
		columns: ['rowid', ...columns],
		rows: page.map((record) => [
			record.__kody_rowid ?? null,
			...columns.map((column) => record[column] ?? null),
		]),
		nextCursor:
			records.length > pageSize && last ? Number(last.__kody_rowid) : null,
	}
}

/**
 * Replay schema objects. The `tables` phase runs first against an empty
 * storage (refusing a non-empty one); the `finish` phase adds indexes, views,
 * and triggers after the rows are copied, so triggers do not fire on the copy.
 */
export function writeStorageSqlSchema(
	exec: StorageSqlExec,
	input: { objects: Array<StorageSqlSchemaObject>; phase: 'tables' | 'finish' },
) {
	if (input.phase === 'tables' && readStorageSqlSchema(exec).length > 0) {
		throw new Error('Target storage already has SQL tables.')
	}
	const ordered = input.objects
		.filter((object) =>
			input.phase === 'tables'
				? object.type === 'table'
				: object.type !== 'table',
		)
		.sort(
			(left, right) =>
				schemaObjectOrder[left.type] - schemaObjectOrder[right.type],
		)
	for (const object of ordered) {
		if (!isUserSchemaObjectName(object.name)) {
			throw new Error(`Refusing reserved SQL object name ${object.name}.`)
		}
		exec(object.sql)
	}
}

export function writeStorageSqlRows(
	exec: StorageSqlExec,
	input: {
		table: string
		columns: Array<string>
		rows: Array<Array<StorageSqlValue>>
	},
) {
	const table = requireUserTable(exec, input.table)
	if (input.columns.length === 0) return 0
	const columnList = input.columns.map(quoteIdentifier).join(', ')
	const placeholders = input.columns.map(() => '?').join(', ')
	const statement = `INSERT INTO ${quoteIdentifier(table.name)} (${columnList}) VALUES (${placeholders})`
	let written = 0
	for (const row of input.rows) {
		if (row.length !== input.columns.length) {
			throw new Error(`Row width does not match columns for ${table.name}.`)
		}
		exec(statement, ...row)
		written += 1
	}
	return written
}

/** Row count per user table, for verifying a copy. */
export function countStorageSqlRows(exec: StorageSqlExec) {
	const counts: Record<string, number> = {}
	for (const object of readStorageSqlSchema(exec)) {
		if (object.type !== 'table') continue
		const [row] = exec(
			`SELECT COUNT(*) AS count FROM ${quoteIdentifier(object.name)}`,
		).toArray()
		counts[object.name] = Number(row?.count ?? 0)
	}
	return counts
}
