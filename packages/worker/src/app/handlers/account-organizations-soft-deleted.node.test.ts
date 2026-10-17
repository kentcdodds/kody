import { expect, test, vi } from 'vitest'
import {
	createAuthCookie,
	setAuthSessionSecret,
	type AuthSession,
} from '#app/auth-session.ts'
import { executePreparedD1Batch } from '#worker/test-support/d1-prepared-batch.ts'
import { testStableUserIdFromEmail } from '#worker/test-support/stable-user-id.ts'

const testCookieSecret = 'test-cookie-secret-0123456789abcdef0123456789'
const email = 'soft-deleted@example.com'
const stableUserId = testStableUserIdFromEmail(email)

vi.mock('#app/account-organizations-data.ts', () => ({
	loadAccountOrganizationsData: vi.fn(async () => {
		throw new Error('organizations loader must not run for soft-deleted people')
	}),
}))

const { createAccountOrganizationsApiHandler } =
	await import('./account-organizations.ts')

function createSoftDeletedEnv() {
	return {
		COOKIE_SECRET: testCookieSecret,
		APP_DB: {
			prepare(query: string) {
				const normalizedQuery = query.replace(/\s+/g, ' ').trim().toLowerCase()
				const statement = {
					query,
					bind: () => statement,
					all: async () => {
						if (
							normalizedQuery.startsWith('select') &&
							normalizedQuery.includes('from "users"')
						) {
							return {
								results: [
									{
										id: 800,
										email,
										username: 'soft-deleted-user',
										stable_user_id: stableUserId,
										deleted_at: '2026-10-16T22:23:07.000Z',
									},
								],
								meta: { changes: 0 },
							}
						}
						if (normalizedQuery.includes('from user_roles')) {
							return { results: [], meta: { changes: 0 } }
						}
						return { results: [], meta: { changes: 0 } }
					},
					first: async () => null,
					run: async () => ({ meta: { changes: 0 } }),
				}
				return statement
			},
			async batch(statements: Array<{ query?: string }>) {
				return await executePreparedD1Batch(statements)
			},
			async exec() {},
		} as unknown as D1Database,
	} as Env
}

test('GET /account/organizations.json returns 401 for a soft-deleted session', async () => {
	setAuthSessionSecret(testCookieSecret)
	const cookie = await createAuthCookie(
		{
			stableUserId,
			email,
			rememberMe: false,
		} satisfies AuthSession,
		false,
	)
	const response = await createAccountOrganizationsApiHandler(
		createSoftDeletedEnv(),
	).handler({
		request: new Request('https://example.com/account/organizations.json', {
			headers: { Cookie: cookie },
		}),
	} as never)

	expect(response.status).toBe(401)
	expect(await response.json()).toEqual({
		ok: false,
		error: 'Unauthorized.',
	})
})
