import { expect, test } from 'vitest'
import { RequestContext } from 'remix/router'
import {
	createAuthCookie,
	setAuthSessionSecret,
	type AuthSession,
} from '#app/auth-session.ts'
import { createSessionHandler } from '#app/handlers/session.ts'
import { testStableUserIdFromEmail } from '#worker/test-support/stable-user-id.ts'

const testCookieSecret = 'test-cookie-secret-0123456789abcdef0123456789'
const rememberedSession: AuthSession = {
	id: '1',
	email: 'user@example.com',
	rememberMe: true,
}

function createSessionRequestContext(cookie: string) {
	return new RequestContext(
		new Request('http://example.com/session', {
			headers: {
				Cookie: cookie,
			},
		}),
	)
}

function createSessionTestDb() {
	const users = new Map([
		[
			1,
			{
				id: 1,
				email: 'user@example.com',
				username: 'session-user',
				password_hash: 'unused',
				stable_user_id: testStableUserIdFromEmail('user@example.com'),
				created_at: new Date(0).toISOString(),
				updated_at: new Date(0).toISOString(),
			},
		],
	])

	function createStatement(query: string, params: Array<unknown> = []) {
		const normalizedQuery = query.replace(/\s+/g, ' ').trim().toLowerCase()
		const executeAll = async () => {
			if (
				normalizedQuery.startsWith('select') &&
				normalizedQuery.includes('from "users"') &&
				/"id"\s*=/.test(normalizedQuery)
			) {
				const user = users.get(Number(params[0]))
				return {
					results: user ? [{ ...user }] : [],
					meta: { changes: 0, last_row_id: 0 },
				}
			}
			if (
				normalizedQuery.includes('from user_roles ur') &&
				normalizedQuery.includes('join roles r')
			) {
				return {
					results: [],
					meta: { changes: 0, last_row_id: 0 },
				}
			}
			// Feature-flag evaluation during /session refresh; empty state uses
			// registry defaults without throwing.
			if (
				normalizedQuery.includes('from feature_flags') ||
				normalizedQuery.includes('from feature_flag_user_overrides')
			) {
				return {
					results: [],
					meta: { changes: 0, last_row_id: 0 },
				}
			}
			return {
				results: [],
				meta: { changes: 0, last_row_id: 0 },
			}
		}
		return {
			bind(...nextParams: Array<unknown>) {
				return createStatement(query, nextParams)
			},
			async all() {
				return executeAll()
			},
			async first() {
				const result = await executeAll()
				return result.results[0] ?? null
			},
			async run() {
				return { meta: { changes: 0, last_row_id: 0 } }
			},
		}
	}

	return {
		prepare(query: string) {
			return createStatement(query)
		},
		async exec() {
			return
		},
	} as unknown as D1Database
}

function createEnv(db = createSessionTestDb()) {
	return {
		APP_DB: db,
		COOKIE_SECRET: testCookieSecret,
	} as Env
}

async function withMockedNow<T>(now: number, callback: () => Promise<T>) {
	const originalDateNow = Date.now
	Date.now = () => now
	try {
		return await callback()
	} finally {
		Date.now = originalDateNow
	}
}

test('session handler only renews remembered sessions after the renewal window', async () => {
	setAuthSessionSecret(testCookieSecret)
	const session = createSessionHandler(createEnv())
	const now = Date.UTC(2026, 1, 1)
	const scenarios = [
		{
			ageDays: 15,
			expectSetCookie: true,
		},
		{
			ageDays: 13,
			expectSetCookie: false,
		},
	] as const

	for (const scenario of scenarios) {
		const cookie = await createAuthCookie(
			rememberedSession,
			false,
			now - 1000 * 60 * 60 * 24 * scenario.ageDays,
		)

		const response = await withMockedNow(now, () =>
			session.handler(createSessionRequestContext(cookie)),
		)

		expect(response.status).toBe(200)
		expect(await response.json()).toEqual({
			ok: true,
			session: {
				email: rememberedSession.email,
				emailVerified: false,
				username: 'session-user',
				roles: [],
				permissions: [],
				featureFlags: {
					'demo-indicator': false,
				},
			},
		})
		if (scenario.expectSetCookie) {
			expect(response.headers.get('Set-Cookie')).toContain('Max-Age=2592000')
		} else {
			expect(response.headers.get('Set-Cookie')).toBeNull()
		}
	}
})

test('session handler clears invalid session cookies for missing users and malformed ids', async () => {
	setAuthSessionSecret(testCookieSecret)
	const session = createSessionHandler(createEnv())
	const invalidCookies = await Promise.all([
		createAuthCookie(
			{
				id: '404',
				email: 'missing@example.com',
				rememberMe: false,
			},
			false,
		),
		createAuthCookie(
			{
				id: '1abc',
				email: 'user@example.com',
				rememberMe: false,
			},
			false,
		),
	])

	for (const cookie of invalidCookies) {
		const response = await session.handler(createSessionRequestContext(cookie))

		expect(response.status).toBe(200)
		expect(await response.json()).toEqual({ ok: false })
		expect(response.headers.get('Set-Cookie')).toContain('Max-Age=0')
	}
})
