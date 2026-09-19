import { expect, test } from 'vitest'
import {
	loadAccountExperimentsData,
	readExperimentsOptIn,
	setExperimentsOptIn,
} from './account-experiments-data.ts'

function createUsersDb(initialOptIn = 0) {
	const users = new Map([[7, { experiments_opt_in: initialOptIn }]])

	function normalize(query: string) {
		return query.replace(/\s+/g, ' ').trim().toLowerCase()
	}

	function createStatement(query: string, params: Array<unknown> = []) {
		const normalized = normalize(query)
		return {
			bind(...next: Array<unknown>) {
				return createStatement(query, next)
			},
			async first<T>() {
				if (
					normalized.includes('select experiments_opt_in from users') &&
					normalized.includes('where id = ?')
				) {
					const row = users.get(Number(params[0]))
					return (
						row ? { experiments_opt_in: row.experiments_opt_in } : null
					) as T | null
				}
				throw new Error(`Unsupported first: ${query}`)
			},
			async run() {
				if (
					normalized.startsWith('update users') &&
					normalized.includes('experiments_opt_in')
				) {
					const enabled = Number(params[0])
					const userId = Number(params[1])
					users.set(userId, { experiments_opt_in: enabled })
					return { meta: { changes: 1 } }
				}
				throw new Error(`Unsupported run: ${query}`)
			},
		}
	}

	return {
		db: {
			prepare(query: string) {
				return createStatement(query)
			},
		} as unknown as D1Database,
	}
}

test('read and set experiments opt-in on the user row', async () => {
	const { db } = createUsersDb(0)
	await expect(readExperimentsOptIn(db, 7)).resolves.toBe(false)
	await expect(loadAccountExperimentsData({ db, userId: 7 })).resolves.toEqual({
		ok: true,
		experimentsOptIn: false,
	})

	await setExperimentsOptIn(db, { userId: 7, enabled: true })
	await expect(readExperimentsOptIn(db, 7)).resolves.toBe(true)
	await expect(loadAccountExperimentsData({ db, userId: 7 })).resolves.toEqual({
		ok: true,
		experimentsOptIn: true,
	})

	await setExperimentsOptIn(db, { userId: 7, enabled: false })
	await expect(readExperimentsOptIn(db, 7)).resolves.toBe(false)
})
