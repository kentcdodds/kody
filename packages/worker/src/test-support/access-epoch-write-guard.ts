/**
 * Test-only D1 wrapper that fails a test when a write to one of the tables
 * that feed roles or the org binding (mcp-auth-cache.ts, access-compile.ts)
 * does not commit together with an `orgs.access_epoch` bump.
 *
 * Rules, per statement run through `run()` or `batch()`:
 * - a write to an access table must be part of a `batch()` that also bumps
 *   `access_epoch`, or that creates/deletes the `orgs` row itself (a new or
 *   removed org has no cached decisions to invalidate);
 * - a lone `run()` of such a write is always an error.
 */

export const accessEpochGuardedTables = [
	'org_memberships',
	'user_roles',
	'grants',
	'grant_permissions',
	'team_members',
	'teams',
] as const

const writePattern = new RegExp(
	String.raw`\b(?:INSERT(?:\s+OR\s+\w+)?\s+INTO|UPDATE|DELETE\s+FROM)\s+(${accessEpochGuardedTables.join('|')})\b`,
	'i',
)
const bumpPattern = /\baccess_epoch\s*=\s*access_epoch\s*\+\s*1\b/i
const orgLifecyclePattern = /\b(?:INSERT\s+INTO|DELETE\s+FROM)\s+orgs\b/i

export function accessTableWrittenBy(sql: string): string | null {
	return writePattern.exec(sql)?.[1] ?? null
}

export function bumpsAccessEpoch(sql: string) {
	return bumpPattern.test(sql)
}

export class AccessEpochWriteGuardError extends Error {
	constructor(table: string, sql: string) {
		super(
			`Write to ${table} without an access_epoch bump in the same D1 batch:\n${sql.replace(/\s+/g, ' ').trim()}`,
		)
		this.name = 'AccessEpochWriteGuardError'
	}
}

type GuardedStatement = D1PreparedStatement & {
	__guardSql?: string
	__guardInBatch?: boolean
}

function assertBatchInvariant(sqls: Array<string>) {
	const bumps = sqls.some(bumpsAccessEpoch)
	const lifecycle = sqls.some((sql) => orgLifecyclePattern.test(sql))
	if (bumps || lifecycle) return
	for (const sql of sqls) {
		const table = accessTableWrittenBy(sql)
		if (table) throw new AccessEpochWriteGuardError(table, sql)
	}
}

/**
 * Wrap a test D1 so every access-table write is checked against the epoch
 * invariant. Reads and writes to other tables pass through untouched.
 */
export function withAccessEpochWriteGuard(db: D1Database): D1Database {
	function guardStatement(statement: D1PreparedStatement, sql: string) {
		const guarded = statement as GuardedStatement
		guarded.__guardSql = sql
		// Test facades may omit `bind` on an already-bound statement.
		const originalBind =
			typeof statement.bind === 'function'
				? statement.bind.bind(statement)
				: null
		const originalRun = statement.run.bind(statement)
		if (originalBind) {
			guarded.bind = (...params: Array<unknown>) =>
				guardStatement(originalBind(...params), sql)
		}
		guarded.run = (async () => {
			// Test facades implement batch() by running each statement; the batch
			// wrapper below already checked the whole batch in that case.
			if (!guarded.__guardInBatch) assertBatchInvariant([sql])
			return await originalRun()
		}) as D1PreparedStatement['run']
		return guarded
	}
	return new Proxy(db, {
		get(target, property, receiver) {
			if (property === 'prepare') {
				return (sql: string) => guardStatement(target.prepare(sql), sql)
			}
			if (property === 'batch') {
				return async (statements: Array<GuardedStatement>) => {
					assertBatchInvariant(
						statements.map((statement) => statement.__guardSql ?? ''),
					)
					for (const statement of statements) statement.__guardInBatch = true
					try {
						return await target.batch(statements)
					} finally {
						for (const statement of statements) {
							statement.__guardInBatch = false
						}
					}
				}
			}
			return Reflect.get(target, property, receiver)
		},
	}) as D1Database
}
