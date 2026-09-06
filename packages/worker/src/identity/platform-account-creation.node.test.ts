import { DatabaseSync } from 'node:sqlite'
import { expect, test } from 'vitest'
import { applyAllMigrations } from '#worker/test-support/apply-all-migrations.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import {
	createPlatformAccount,
	type PlatformAccountCreateError,
} from './platform-account-creation.ts'

function createMigratedDb() {
	const sqlite = new DatabaseSync(':memory:')
	applyAllMigrations(sqlite, new URL('../../migrations/', import.meta.url))
	return { sqlite, db: createD1FromSqlite(sqlite) }
}

test('rolls back the inserted platform user when claiming the email fails', async () => {
	const { sqlite, db } = createMigratedDb()
	const failingDb = new Proxy(db, {
		get(target, property, receiver) {
			if (property === 'prepare') {
				return (sql: string) => {
					if (sql.includes('INSERT INTO user_email_claims')) {
						throw new Error('forced claim failure')
					}
					return target.prepare(sql)
				}
			}
			return Reflect.get(target, property, receiver)
		},
	})
	const email = 'platform@example.com'

	await expect(
		createPlatformAccount({
			db: failingDb,
			email,
			username: 'kody',
		}),
	).rejects.toMatchObject({
		code: 'create_failed',
	} satisfies Partial<PlatformAccountCreateError>)

	expect(
		sqlite
			.prepare(`SELECT COUNT(*) AS count FROM users WHERE email = ?`)
			.get(email) as { count: number },
	).toEqual({ count: 0 })
})
