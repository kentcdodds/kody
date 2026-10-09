import { DatabaseSync } from 'node:sqlite'
import { expect, test } from 'vitest'
import { provisionPersonalOrg } from '#worker/orgs/provision.ts'
import { applyAllMigrations } from '#worker/test-support/apply-all-migrations.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { consumeSearchRateLimit } from './search-rate-limit.ts'

const migrationsDirectory = new URL('../migrations/', import.meta.url)
const stableUserId = 'ab'.repeat(32)

test('back-to-back searches resolve the rate-limit plan from the hot-path cache', async () => {
	const sqlite = new DatabaseSync(':memory:')
	applyAllMigrations(sqlite, migrationsDirectory)
	const db = createD1FromSqlite(sqlite)
	await db
		.prepare(
			`INSERT INTO users (username, email, password_hash, stable_user_id, plan)
			VALUES ('cached', 'cached@example.com', 'x', ?, 'standard')`,
		)
		.bind(stableUserId)
		.run()
	await provisionPersonalOrg(db, {
		stableUserId,
		username: 'cached',
		plan: 'standard',
	})
	const statements: Array<string> = []
	const counted = new Proxy(db, {
		get(target, property, receiver) {
			if (property === 'prepare') {
				return (query: string) => {
					statements.push(query)
					return target.prepare(query)
				}
			}
			const value = Reflect.get(target, property, receiver)
			return typeof value === 'function' ? value.bind(target) : value
		},
	})

	const input = {
		db: counted,
		userId: stableUserId,
		email: 'cached@example.com',
	}
	expect(await consumeSearchRateLimit(input)).toBe('standard')
	expect(await consumeSearchRateLimit(input)).toBe('standard')
	// One org-first JOIN (FROM users … INNER JOIN orgs); the second call hits cache.
	expect(
		statements.filter((query) => /\bFROM users\b/i.test(query)),
	).toHaveLength(1)
})
