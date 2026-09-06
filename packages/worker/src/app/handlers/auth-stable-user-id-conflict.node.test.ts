import { DatabaseSync } from 'node:sqlite'
import { RequestContext } from 'remix/router'
import { beforeAll, expect, test, vi } from 'vitest'
import { setAuthSessionSecret } from '#app/auth-session.ts'
import { quoteSqlString } from '@kody-internal/shared/sql-literals.ts'
import { applyAllMigrations } from '#worker/test-support/apply-all-migrations.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import {
	auditEventSummaries,
	logAuditEventSpy,
} from '#worker/test-support/audit-log-spy.ts'
import {
	formerEmailClaimedSignupCode,
	formerEmailClaimedSignupMessage,
} from '#universal/email-claim-errors.ts'
import { createStableUserIdFromEmail } from '#worker/user-id.ts'

const lifecycleMocks = vi.hoisted(() => ({
	scheduleUserCreatedEvent: vi.fn(),
}))

vi.mock('#worker/identity/schedule-user-lifecycle-event.ts', () => ({
	scheduleUserCreatedEvent: (...args: Array<unknown>) =>
		lifecycleMocks.scheduleUserCreatedEvent(...args),
	scheduleUserDeletedEvent: vi.fn(),
}))

const { createAuthHandler } = await import('#app/handlers/auth.ts')

const testCookieSecret = 'test-cookie-secret-0123456789abcdef0123456789'
const conflictMessage = formerEmailClaimedSignupMessage

function applyMigrations(db: DatabaseSync) {
	const migrationsDir = new URL('../../../migrations/', import.meta.url)
	applyAllMigrations(db, migrationsDir)
}

function createMigratedDb() {
	const sqlite = new DatabaseSync(':memory:')
	applyMigrations(sqlite)
	return { sqlite, db: createD1FromSqlite(sqlite) }
}

function seedSquattingAccount(
	sqlite: DatabaseSync,
	input: { email: string; username: string; stableUserId: string },
) {
	sqlite.exec(`
		INSERT INTO users (username, email, stable_user_id, password_hash)
		VALUES (
			${quoteSqlString(input.username)},
			${quoteSqlString(input.email)},
			${quoteSqlString(input.stableUserId)},
			'oauth_created_no_usable_password'
		);
	`)
}

function seedInvite(sqlite: DatabaseSync, code: string) {
	sqlite.exec(`
		INSERT INTO invites (code, created_by, note, max_uses, use_count)
		VALUES (${quoteSqlString(code)}, NULL, '', 1, 0);
	`)
}

function createHandler(db: D1Database, signupMode: 'open' | 'invite') {
	return createAuthHandler({
		COOKIE_SECRET: testCookieSecret,
		APP_DB: db,
		SIGNUP_MODE: signupMode,
		SENTRY_ENVIRONMENT: signupMode === 'open' ? 'test' : 'production',
	} as unknown as Parameters<typeof createAuthHandler>[0])
}

async function signup(
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

beforeAll(() => {
	setAuthSessionSecret(testCookieSecret)
})

test('signup returns 409 when sha256(email) collides with an existing stable_user_id and releases the invite', async () => {
	const victimEmail = 'victim@example.com'
	const victimStableUserId = await createStableUserIdFromEmail(victimEmail)
	const { sqlite, db } = createMigratedDb()
	seedSquattingAccount(sqlite, {
		email: 'attacker@example.com',
		username: 'attacker',
		stableUserId: victimStableUserId,
	})
	const openHandler = createHandler(db, 'open')

	const openResponse = await signup(openHandler, {
		email: victimEmail,
		username: 'victim-jane',
		password: 'password123',
		mode: 'signup',
	})
	expect(openResponse.status).toBe(409)
	expect(await openResponse.json()).toEqual({
		error: conflictMessage,
		code: formerEmailClaimedSignupCode,
	})
	expect(sqlite.prepare(`SELECT COUNT(*) AS count FROM users`).get()).toEqual({
		count: 1,
	})
	expect(lifecycleMocks.scheduleUserCreatedEvent).not.toHaveBeenCalled()
	expect(logAuditEventSpy).toHaveBeenCalledWith(
		expect.objectContaining({
			category: 'auth',
			action: 'signup',
			result: 'failure',
			reason: 'former_email_claimed',
		}),
	)

	seedInvite(sqlite, 'STABLE-ID-INVITE')
	const inviteHandler = createHandler(db, 'invite')
	const invitedResponse = await signup(inviteHandler, {
		email: victimEmail,
		username: 'victim-invited',
		password: 'password123',
		mode: 'signup',
		inviteCode: 'stable-id-invite',
	})
	expect(invitedResponse.status).toBe(409)
	expect(await invitedResponse.json()).toEqual({
		error: conflictMessage,
		code: formerEmailClaimedSignupCode,
	})
	expect(
		sqlite
			.prepare(`SELECT use_count FROM invites WHERE code = ?`)
			.get('STABLE-ID-INVITE') as { use_count: number },
	).toEqual({ use_count: 0 })
	expect(auditEventSummaries()).toEqual(['signup:failure', 'signup:failure'])
})
