import { beforeAll, expect, test, vi } from 'vitest'
import { RequestContext } from 'remix/router'
import type * as AccountDeletion from '#app/account-deletion.ts'
import { setAuthSessionSecret } from '#app/auth-session.ts'
import { accountDeletionConfirmationPhrase } from '#universal/account-deletion-confirmation.ts'
import { auditEventSummaries } from '#worker/test-support/audit-log-spy.ts'

const mocks = vi.hoisted(() => ({
	readAuthenticatedAppUserForDeletion: vi.fn(),
	deleteUserAccount: vi.fn(),
	scheduleUserDeletedEvent: vi.fn(),
	findOne: vi.fn(),
	verifyPassword: vi.fn(),
}))

vi.mock('#app/authenticated-user.ts', () => ({
	readAuthenticatedAppUserForDeletion: (...args: Array<unknown>) =>
		mocks.readAuthenticatedAppUserForDeletion(...args),
}))

vi.mock('#app/account-deletion.ts', async (importOriginal) => {
	const actual = await importOriginal<typeof AccountDeletion>()
	return {
		...actual,
		deleteUserAccount: (...args: Array<unknown>) =>
			mocks.deleteUserAccount(...args),
	}
})

vi.mock('#worker/identity/schedule-user-lifecycle-event.ts', () => ({
	scheduleUserCreatedEvent: vi.fn(),
	scheduleUserDeletedEvent: (...args: Array<unknown>) =>
		mocks.scheduleUserDeletedEvent(...args),
}))

vi.mock('#worker/db.ts', () => ({
	createDb: () => ({
		findOne: (...args: Array<unknown>) => mocks.findOne(...args),
	}),
	usersTable: {},
}))

vi.mock('@kody-internal/shared/password-hash.ts', () => ({
	verifyPassword: (...args: Array<unknown>) => mocks.verifyPassword(...args),
}))

const { createAccountDeleteHandler } = await import('./account-delete.ts')

const testCookieSecret = 'test-cookie-secret-0123456789abcdef0123456789'

const signedInUser = {
	userId: 7,
	username: 'ada',
	email: 'ada@example.com',
	mcpUser: { userId: 'stable-ada' },
}

function createHandler() {
	return createAccountDeleteHandler({
		COOKIE_SECRET: testCookieSecret,
		APP_DB: {} as D1Database,
		APP_BASE_URL: 'https://kody.example',
	} as Env)
}

async function requestDelete(body: unknown) {
	const request = new Request('https://example.com/account/delete', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: typeof body === 'string' ? body : JSON.stringify(body),
	})
	return createHandler().handler(new RequestContext(request) as never)
}

beforeAll(() => {
	setAuthSessionSecret(testCookieSecret)
})

test('account deletion requires GOODBYE KODY, password when one exists, and emits user.deleted', async () => {
	const handlerUserMissing = createHandler()
	mocks.readAuthenticatedAppUserForDeletion.mockResolvedValueOnce(null)
	const unauthenticated = await handlerUserMissing.handler(
		new RequestContext(
			new Request('https://example.com/account/delete', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					confirmation: accountDeletionConfirmationPhrase,
				}),
			}),
		) as never,
	)
	expect(unauthenticated.status).toBe(401)

	mocks.readAuthenticatedAppUserForDeletion.mockResolvedValue(signedInUser)
	mocks.findOne.mockResolvedValue({
		id: 7,
		password_hash: 'pbkdf2_sha256$100000$salt$hash',
	})
	mocks.verifyPassword.mockResolvedValue(false)
	mocks.deleteUserAccount.mockResolvedValue({
		deletedRowCounts: { users: 1 },
		warnings: [],
	})

	const missingConfirmation = await requestDelete({ password: 'secret' })
	expect(missingConfirmation.status).toBe(400)

	const wrongPhrase = await requestDelete({
		confirmation: 'goodbye kody',
		password: 'secret',
	})
	expect(wrongPhrase.status).toBe(400)

	const missingPassword = await requestDelete({
		confirmation: accountDeletionConfirmationPhrase,
	})
	expect(missingPassword.status).toBe(400)

	const wrongPassword = await requestDelete({
		confirmation: accountDeletionConfirmationPhrase,
		password: 'nope',
	})
	expect(wrongPassword.status).toBe(401)
	expect(mocks.deleteUserAccount).not.toHaveBeenCalled()

	mocks.verifyPassword.mockResolvedValue(true)
	const deleted = await requestDelete({
		confirmation: `  ${accountDeletionConfirmationPhrase}  `,
		password: 'secret',
	})
	expect(deleted.status).toBe(200)
	expect(await deleted.json()).toMatchObject({
		ok: true,
		deletedRowCounts: { users: 1 },
	})
	expect(deleted.headers.get('Set-Cookie') ?? '').toContain('kody_session=')
	expect(mocks.deleteUserAccount).toHaveBeenCalledWith({
		env: expect.objectContaining({ COOKIE_SECRET: testCookieSecret }),
		dbUserId: 7,
		mcpUserId: 'stable-ada',
	})
	expect(mocks.scheduleUserDeletedEvent).toHaveBeenCalledWith({
		env: expect.objectContaining({ COOKIE_SECRET: testCookieSecret }),
		user: {
			id: 'stable-ada',
			username: 'ada',
			email: 'ada@example.com',
		},
	})

	mocks.findOne.mockResolvedValue({
		id: 7,
		password_hash: 'oauth_created_no_usable_password',
	})
	mocks.deleteUserAccount.mockClear()
	mocks.scheduleUserDeletedEvent.mockClear()
	const oauthDeleted = await requestDelete({
		confirmation: accountDeletionConfirmationPhrase,
	})
	expect(oauthDeleted.status).toBe(200)
	expect(mocks.verifyPassword).toHaveBeenCalledTimes(2)
	expect(mocks.deleteUserAccount).toHaveBeenCalledOnce()
	expect(mocks.scheduleUserDeletedEvent).toHaveBeenCalledOnce()

	expect(auditEventSummaries()).toEqual([
		'account_delete:failure',
		'account_delete:failure',
		'account_delete:failure',
		'account_delete:success',
		'account_delete:success',
	])
})
