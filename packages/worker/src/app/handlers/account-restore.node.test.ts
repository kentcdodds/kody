import { expect, test, vi } from 'vitest'
import { RequestContext } from 'remix/router'
import { createAccountRestoreHandler } from '#app/handlers/account-restore.ts'
import { createAuthHandler } from '#app/handlers/auth.ts'
import {
	issueAccountRestoreCookie,
	readAccountRestoreProof,
	readSoftDeletedSignIn,
	setAccountRestoreSecret,
} from '#app/account-restore.ts'
import { setAuthSessionSecret } from '#app/auth-session.ts'
import { softDeletePurgeCutoffIso } from '#worker/soft-delete/window.ts'
import {
	createAppEnv,
	createMigratedDb,
	seedUser,
	testCookieSecret,
} from '#worker/test-support/auth-provider-harness.ts'
import { testStableUserIdFromEmail } from '#worker/test-support/stable-user-id.ts'
import { consoleWarn } from '#worker/test-support/console-spies.ts'

const restoreUserAccount = vi.hoisted(() => vi.fn())

vi.mock('#worker/orgs/soft-delete.ts', async (importOriginal) => {
	const actual =
		await importOriginal<typeof import('#worker/orgs/soft-delete.ts')>()
	return {
		...actual,
		restoreUserAccount: (...args: Array<unknown>) =>
			restoreUserAccount(...args),
	}
})

const email = 'restore-me@example.com'
const stableUserId = testStableUserIdFromEmail(email)

function softDelete(
	sqlite: { exec: (sql: string) => void },
	deletedAt: string,
) {
	sqlite.exec(
		`UPDATE users SET deleted_at = '${deletedAt}' WHERE email = '${email}'`,
	)
}

test('soft-deleted sign-in is restorable inside the window and deleted after it', async () => {
	const { sqlite, db } = createMigratedDb()
	await seedUser(sqlite, {
		id: 1,
		email,
		username: 'restore-me',
		stableUserId,
	})
	expect((await readSoftDeletedSignIn(db, email)).kind).toBe('live')

	softDelete(sqlite, new Date().toISOString())
	expect((await readSoftDeletedSignIn(db, email)).kind).toBe('restore')

	const beforeWindow = new Date(softDeletePurgeCutoffIso(new Date()))
	beforeWindow.setUTCSeconds(beforeWindow.getUTCSeconds() - 1)
	softDelete(sqlite, beforeWindow.toISOString())
	expect((await readSoftDeletedSignIn(db, email)).kind).toBe('expired')
})

test('password login during the restore window prompts and does not start a session', async () => {
	const { sqlite, db } = createMigratedDb()
	await seedUser(sqlite, {
		id: 3,
		email,
		username: 'restore-me',
		stableUserId,
	})
	sqlite
		.prepare(`UPDATE users SET deleted_at = ? WHERE email = ?`)
		.run(new Date().toISOString(), email)
	setAuthSessionSecret(testCookieSecret)
	const handler = createAuthHandler(createAppEnv(db))
	const response = await handler.handler(
		new RequestContext(
			new Request('http://example.com/auth', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					email,
					password: 'test-password',
					mode: 'login',
				}),
			}),
		),
	)
	expect(response.status).toBe(200)
	expect(await response.json()).toMatchObject({
		ok: true,
		mode: 'login',
		accountRestoreRequired: true,
		restoreWindowDays: 30,
	})
	const setCookies = response.headers.getSetCookie()
	expect(
		setCookies.some((cookie) => cookie.startsWith('kody_account_restore=')),
	).toBe(true)
	expect(
		setCookies.some(
			(cookie) =>
				cookie.startsWith('kody_session=') && !cookie.includes('Max-Age=0'),
		),
	).toBe(false)

	sqlite
		.prepare(`UPDATE users SET deleted_at = ? WHERE email = ?`)
		.run('2020-01-01T00:00:00.000Z', email)
	const expired = await handler.handler(
		new RequestContext(
			new Request('http://example.com/auth', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					email,
					password: 'test-password',
					mode: 'login',
				}),
			}),
		),
	)
	expect(expired.status).toBe(401)
	expect(await expired.json()).toEqual({ error: 'Invalid email or password.' })
	expect(expired.headers.get('Set-Cookie')).toBeNull()
})

test('confirm restores the account and signs in; decline stays signed out', async () => {
	consoleWarn.mockImplementation(() => {})
	restoreUserAccount.mockClear()
	restoreUserAccount.mockResolvedValue({
		userId: stableUserId,
		restoredAt: '2026-10-09T00:00:00.000Z',
		restoredOrgIds: [],
	})
	setAuthSessionSecret(testCookieSecret)
	setAccountRestoreSecret(testCookieSecret)
	const { sqlite, db } = createMigratedDb()
	await seedUser(sqlite, {
		id: 2,
		email,
		username: 'restore-me',
		stableUserId,
		emailVerified: true,
	})
	sqlite
		.prepare(`UPDATE users SET deleted_at = ? WHERE email = ?`)
		.run(new Date().toISOString(), email)
	const env = createAppEnv(db)
	const handler = createAccountRestoreHandler(env)
	const restoreCookie = await issueAccountRestoreCookie({
		secret: testCookieSecret,
		email,
		stableUserId,
		rememberMe: true,
		secure: false,
	})

	const decline = await handler.handler(
		new RequestContext(
			new Request('http://example.com/auth/restore-account', {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					Cookie: restoreCookie,
				},
				body: JSON.stringify({ intent: 'decline' }),
			}),
		),
	)
	expect(decline.status).toBe(200)
	expect(await decline.json()).toEqual({ ok: true, declined: true })
	expect(decline.headers.get('Set-Cookie') ?? '').toContain('Max-Age=0')
	expect(restoreUserAccount).not.toHaveBeenCalled()
	expect(decline.headers.get('Set-Cookie') ?? '').not.toContain('kody_session=')

	const confirm = await handler.handler(
		new RequestContext(
			new Request('http://example.com/auth/restore-account', {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					Cookie: restoreCookie,
				},
				body: JSON.stringify({ intent: 'restore' }),
			}),
		),
	)
	expect(confirm.status).toBe(200)
	expect(await confirm.json()).toMatchObject({ ok: true, restored: true })
	const setCookies = confirm.headers.getSetCookie()
	expect(setCookies.some((cookie) => cookie.startsWith('kody_session='))).toBe(
		true,
	)
	expect(
		setCookies.some(
			(cookie) =>
				cookie.startsWith('kody_account_restore=') &&
				cookie.includes('Max-Age=0'),
		),
	).toBe(true)
	expect(restoreUserAccount).toHaveBeenCalledWith(
		expect.objectContaining({
			userId: stableUserId,
			actorUserId: stableUserId,
			actorUsername: 'restore-me',
		}),
	)

	const proofRequest = new Request('http://example.com/auth/restore-account', {
		headers: { Cookie: restoreCookie },
	})
	expect(await readAccountRestoreProof(proofRequest)).toMatchObject({
		email,
		stableUserId,
		rememberMe: true,
	})
})
