import { type DatabaseSync } from 'node:sqlite'

export type CreateD1FromSqliteOptions = {
	/**
	 * When set, `bind(...params)` throws if `params.length` exceeds the limit
	 * (used to exercise D1 binding-count constraints in tests).
	 */
	maxBindings?: number
	/** Invoked with the row count whenever `all()` returns results. */
	onQueryRows?: (rowCount: number) => void
	/**
	 * When provided, each prepared query is appended after whitespace
	 * normalization (useful for asserting which SQL a code path issues).
	 */
	queries?: Array<string>
}

type StatementRunner = {
	run: () => Promise<unknown>
}

/**
 * Thin D1Database facade over `node:sqlite` `DatabaseSync` for `*.node.test.ts`
 * suites that need SQL without Cloudflare Workers bindings.
 *
 * Prefer importing this over copy-pasting a local helper. Pass options only when
 * a test needs query capture, binding limits, or row-count hooks.
 */
export function createD1FromSqlite(
	db: DatabaseSync,
	options: CreateD1FromSqliteOptions = {},
): D1Database {
	function assertBindingCount(params: Array<unknown>) {
		if (
			options.maxBindings !== undefined &&
			params.length > options.maxBindings
		) {
			throw new Error(`too many SQL variables: ${params.length}`)
		}
	}

	function createPreparedStatement(query: string) {
		return {
			query,
			bind(...params: Array<unknown>) {
				assertBindingCount(params)
				return {
					query,
					async all<T>() {
						const statement = db.prepare(query)
						const rows = statement.all(...params) as Array<T>
						options.onQueryRows?.(rows.length)
						return {
							results: rows,
							meta: { changes: 0, last_row_id: 0 },
						}
					},
					async first<T>() {
						const statement = db.prepare(query)
						return (statement.get(...params) ?? null) as T | null
					},
					async run() {
						const statement = db.prepare(query)
						const result = statement.run(...params)
						return {
							meta: {
								changes: result.changes,
								last_row_id: Number(result.lastInsertRowid),
							},
						}
					},
				}
			},
			async all<T>() {
				const statement = db.prepare(query)
				const rows = statement.all() as Array<T>
				options.onQueryRows?.(rows.length)
				return {
					results: rows,
					meta: { changes: 0, last_row_id: 0 },
				}
			},
			async first<T>() {
				const statement = db.prepare(query)
				return (statement.get() ?? null) as T | null
			},
			async run() {
				const statement = db.prepare(query)
				const result = statement.run()
				return {
					meta: {
						changes: result.changes,
						last_row_id: Number(result.lastInsertRowid),
					},
				}
			},
		}
	}

	return {
		prepare(query: string) {
			options.queries?.push(query.replace(/\s+/g, ' ').trim())
			return createPreparedStatement(query)
		},
		async batch(statements: Array<StatementRunner>) {
			const results = []
			db.exec('BEGIN')
			try {
				for (const statement of statements) {
					results.push(await statement.run())
				}
				db.exec('COMMIT')
				return results
			} catch (error) {
				db.exec('ROLLBACK')
				throw error
			}
		},
		async exec(query: string) {
			db.exec(query)
		},
	} as unknown as D1Database
}
