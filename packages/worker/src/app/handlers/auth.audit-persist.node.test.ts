import { readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { expect, test, vi } from 'vitest'
import { RequestContext } from 'remix/router'
import { quoteSqlString } from '@kody-internal/shared/sql-literals.ts'
import { createPasswordHash } from '@kody-internal/shared/password-hash.ts'
import { setAuthSessionSecret } from '#app/auth-session.ts'
import { createAuthHandler } from '#app/handlers/auth.ts'
import { applyAllMigrations } from '#worker/test-support/apply-all-migrations.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { createStableUserIdFromEmail } from '#worker/user-id.ts'

vi.unmock('#worker/audit-log.ts')

const testCookieSecret = 'test-cookie-secret-0123456789abcdef0123456789'

function createAuditDb() {
	const sqlite = new DatabaseSync(':memory:')
	sqlite.exec(
		readFileSync(
			new URL(
				'../../../audit-migrations/0001-audit-events.sql',
				import.meta.url,
			),
			'utf8',
		),
	)
	return { sqlite, db: createD1FromSqlite(sqlite) }
}

function createAppDb() {
	const sqlite = new DatabaseSync(':memory:')
	applyAllMigrations(sqlite, new URL('../../../migrations/', import.meta.url))
	return { sqlite, db: createD1FromSqlite(sqlite) }
}

async function seedUser(
	sqlite: DatabaseSync,
	input: { id: number; email: string; username: string; password: string },
) {
	const passwordHash = await createPasswordHash(input.password)
	const stableUserId = await createStableUserIdFromEmail(input.email)
	sqlite.exec(`
		INSERT INTO users (
			id,
			username,
			email,
			stable_user_id,
			password_hash,
			email_verified_at
		) VALUES (
			${input.id},
			${quoteSqlString(input.username)},
			${quoteSqlString(input.email)},
			${quoteSqlString(stableUserId)},
			${quoteSqlString(passwordHash)},
			CURRENT_TIMESTAMP
		);
	`)
}

function createHandler(appDb: D1Database, auditDb: D1Database) {
	return createAuthHandler({
		COOKIE_SECRET: testCookieSecret,
		APP_DB: appDb,
		AUDIT_DB: auditDb,
		SIGNUP_MODE: 'invite',
		SENTRY_ENVIRONMENT: 'production',
	} as unknown as Parameters<typeof createAuthHandler>[0])
}

async function postAuth(
	handler: ReturnType<typeof createAuthHandler>,
	body: Record<string, unknown>,
) {
	const request = new Request('http://example.com/auth', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(body),
	})
	return handler.handler(new RequestContext(request))
}

function readAuditActions(sqlite: DatabaseSync) {
	return sqlite
		.prepare(`SELECT action, result FROM audit_events ORDER BY id`)
		.all() as Array<{ action: string; result: string }>
}

test('auth handler persists signup failure and login success to AUDIT_DB', async () => {
	setAuthSessionSecret(testCookieSecret)
	const app = createAppDb()
	const audit = createAuditDb()
	const handler = createHandler(app.db, audit.db)
	await seedUser(app.sqlite, {
		id: 1,
		email: 'session-user@example.com',
		username: 'session-user',
		password: 'secret123',
	})

	const signupFailure = await postAuth(handler, {
		email: 'weak@example.com',
		username: 'weak-user',
		password: 'short',
		mode: 'signup',
	})
	expect(signupFailure.status).toBe(400)
	expect(await signupFailure.json()).toEqual({
		error: 'Password must be at least 8 characters.',
	})
	await vi.waitFor(() => {
		expect(readAuditActions(audit.sqlite)).toEqual([
			{ action: 'signup', result: 'failure' },
		])
	})

	const loginSuccess = await postAuth(handler, {
		email: 'session-user@example.com',
		password: 'secret123',
		mode: 'login',
	})
	expect(loginSuccess.status).toBe(200)
	expect(await loginSuccess.json()).toEqual({ ok: true, mode: 'login' })
	await vi.waitFor(() => {
		expect(readAuditActions(audit.sqlite)).toEqual([
			{ action: 'signup', result: 'failure' },
			{ action: 'login', result: 'success' },
		])
	})
})
