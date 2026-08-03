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
	| 'frozen-rollback-audit'
	| 'drop-tooling'

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
		if (character === "'") {
			index += 1
			while (index < sql.length) {
				if (sql[index] === "'") {
					if (sql[index + 1] === "'") {
						index += 2
						continue
					}
					index += 1
					break
				}
				index += 1
			}
			continue
		}
		if (character === '"' || character === '`' || character === '[') {
			const close = character === '[' ? ']' : character
			const start = index + 1
			index = start
			while (index < sql.length && sql[index] !== close) index += 1
			addIdentifier(sql.slice(start, index))
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
	if (input.marker !== 'live-user') return
	const identifiers = sqlIdentifiers(input.sql)
	const targeted = frozenUserEmailGraphTables.filter((table) =>
		identifiers.has(table),
	)
	if (targeted.length > 0) {
		throw new Error(
			`Live USER D1 access to frozen email graph is forbidden: ${targeted.join(', ')}`,
		)
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
	return new Proxy(db, {
		get(target, property, receiver) {
			if (property === 'prepare') {
				return (sql: string) =>
					prepareUserEmailD1Statement({
						db: target,
						sql,
						marker: 'live-user',
					})
			}
			if (property === 'exec') {
				return (sql: string) => {
					assertUserEmailD1StatementAllowed({
						sql,
						marker: 'live-user',
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
