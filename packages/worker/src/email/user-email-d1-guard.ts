import { systemEmailOwnerId } from './email-owner.ts'

export const frozenUserEmailGraphTables = [
	'email_threads',
	'email_messages',
	'email_attachments',
	'email_delivery_events',
] as const

export type UserEmailD1AccessMarker =
	| 'live-user'
	| 'system-legacy-rollback'
	| 'frozen-privacy-cleanup'
	| 'frozen-backup-audit'
	| 'drop-tooling'

const sqliteIdentifierPrefixes = new Set([
	'FROM',
	'INTO',
	'JOIN',
	'ON',
	'REFERENCES',
	'TABLE',
	'UPDATE',
])

function isSqliteSingleQuotedIdentifier(sql: string, quoteIndex: number) {
	let cursor = quoteIndex - 1
	while (cursor >= 0 && /\s/.test(sql[cursor] ?? '')) cursor -= 1
	if (sql[cursor] === '.') return true
	const end = cursor + 1
	while (cursor >= 0 && /[A-Za-z]/.test(sql[cursor] ?? '')) cursor -= 1
	return sqliteIdentifierPrefixes.has(sql.slice(cursor + 1, end).toUpperCase())
}

function sqlIdentifiers(sql: string): Set<string> {
	const identifiers = new Set<string>()
	const addIdentifier = (value: string) => {
		const normalized = value.trim().toLowerCase()
		if (/^[a-z_][a-z0-9_]*$/.test(normalized)) {
			identifiers.add(normalized)
		}
	}
	let index = 0
	while (index < sql.length) {
		const character = sql[index]
		if (
			character === "'" ||
			character === '"' ||
			character === '`' ||
			character === '['
		) {
			const close = character === '[' ? ']' : character
			const start = index + 1
			index = start
			let identifier = ''
			while (index < sql.length) {
				if (sql[index] !== close) {
					identifier += sql[index]
					index += 1
					continue
				}
				if (sql[index + 1] === close) {
					identifier += close
					index += 2
					continue
				}
				break
			}
			if (character !== "'" || isSqliteSingleQuotedIdentifier(sql, start - 1)) {
				addIdentifier(identifier || sql.slice(start, index))
			}
			index += index < sql.length ? 1 : 0
			continue
		}
		if (character === '-' && sql[index + 1] === '-') {
			index = sql.indexOf('\n', index + 2)
			if (index < 0) break
			continue
		}
		if (character === '/' && sql[index + 1] === '*') {
			const end = sql.indexOf('*/', index + 2)
			index = end < 0 ? sql.length : end + 2
			continue
		}
		if (character && /[A-Za-z_]/.test(character)) {
			const start = index
			index += 1
			while (index < sql.length && /[A-Za-z0-9_]/.test(sql[index] ?? '')) {
				index += 1
			}
			addIdentifier(sql.slice(start, index))
			continue
		}
		index += 1
	}
	return identifiers
}

export function assertUserEmailD1StatementAllowed(input: {
	sql: string
	marker: UserEmailD1AccessMarker
}) {
	const identifiers = sqlIdentifiers(input.sql)
	const targeted = frozenUserEmailGraphTables.filter((table) =>
		identifiers.has(table),
	)
	if (targeted.length === 0) return
	switch (input.marker) {
		case 'live-user':
			throw new Error(
				`Live USER D1 access to frozen email graph is forbidden: ${targeted.join(', ')}`,
			)
		case 'frozen-privacy-cleanup':
			if (!/^\s*(?:SELECT|DELETE)\b/i.test(input.sql)) {
				throw new Error(
					`Frozen USER privacy cleanup permits only SELECT/DELETE: ${targeted.join(', ')}`,
				)
			}
			return
		case 'frozen-backup-audit':
			if (!/^\s*SELECT\b/i.test(input.sql)) {
				throw new Error(
					`Frozen USER backup audit is read-only: ${targeted.join(', ')}`,
				)
			}
			return
		case 'system-legacy-rollback':
		case 'drop-tooling':
			return
		default: {
			const exhaustive: never = input.marker
			throw new Error(`Unhandled USER email D1 marker: ${exhaustive}`)
		}
	}
}

export function prepareUserEmailD1Statement(input: {
	db: D1Database
	sql: string
	marker: UserEmailD1AccessMarker
}): D1PreparedStatement {
	assertUserEmailD1StatementAllowed(input)
	return input.db.prepare(input.sql)
}

/**
 * Production boundary for a live USER email flow.
 *
 * Every statement prepared or executed through the returned database is
 * checked before D1 sees it. Bound statements passed to `batch` necessarily
 * came through `prepare`, so the check still happens before execution.
 */
export function liveUserEmailD1Database(db: D1Database): D1Database {
	return markedUserEmailD1Database(db, 'live-user')
}

export function markedUserEmailD1Database(
	db: D1Database,
	marker: UserEmailD1AccessMarker,
): D1Database {
	return new Proxy(db, {
		get(target, property, receiver) {
			if (property === 'prepare') {
				return (sql: string) =>
					prepareUserEmailD1Statement({
						db: target,
						sql,
						marker,
					})
			}
			if (property === 'exec') {
				return (sql: string) => {
					assertUserEmailD1StatementAllowed({
						sql,
						marker,
					})
					return target.exec(sql)
				}
			}
			const value = Reflect.get(target, property, receiver)
			return typeof value === 'function' ? value.bind(target) : value
		},
	})
}

export function assertLegacyUserEmailGraphServiceDisabled(input: {
	ownerId: string
	operation: string
}) {
	if (input.ownerId === systemEmailOwnerId) return
	throw new Error(
		`Legacy USER D1 email graph operation is disabled after Mailbox cutover: ${input.operation}`,
	)
}
