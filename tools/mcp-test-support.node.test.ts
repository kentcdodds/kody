import { DatabaseSync } from 'node:sqlite'
import { expect, test } from 'vitest'
import { applyAllMigrations } from '#worker/test-support/apply-all-migrations.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { seedMcpTestUser } from './mcp-test-support.ts'

test('seedMcpTestUser upserts a verified user with the default role', async () => {
	const sqlite = new DatabaseSync(':memory:')
	applyAllMigrations(
		sqlite,
		new URL('../packages/worker/migrations/', import.meta.url),
	)
	const db = createD1FromSqlite(sqlite)
	const user = {
		email: 'kody@example.com',
		username: 'mcp-test-user',
		password: 'ilikecode',
	}

	await seedMcpTestUser(db, user)
	await seedMcpTestUser(db, { ...user, username: 'mcp-test-user-renamed' })

	expect(
		sqlite
			.prepare(
				`SELECT username, plan, email_verified_at IS NOT NULL AS verified
FROM users
WHERE email = ?`,
			)
			.get(user.email),
	).toEqual({
		username: 'mcp-test-user-renamed',
		plan: 'free',
		verified: 1,
	})
	expect(
		sqlite
			.prepare(
				`SELECT r.name AS role
FROM user_roles ur
JOIN roles r ON r.id = ur.role_id
JOIN users u ON u.id = ur.user_id
WHERE u.email = ?`,
			)
			.get(user.email),
	).toEqual({ role: 'user' })
})
