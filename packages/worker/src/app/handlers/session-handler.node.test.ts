import { beforeAll, expect, test } from 'vitest'
import { RequestContext } from 'remix/fetch-router'
import {
	createAuthCookie,
	setAuthSessionSecret,
	type AuthSession,
} from '#app/auth-session.ts'
import { session } from '#app/handlers/session.ts'

const testCookieSecret = 'test-cookie-secret-0123456789abcdef0123456789'
const rememberedSession: AuthSession = {
	id: 'session-id',
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

async function withMockedNow<T>(now: number, callback: () => Promise<T>) {
	const originalDateNow = Date.now
	Date.now = () => now
	try {
		return await callback()
	} finally {
		Date.now = originalDateNow
	}
}

beforeAll(() => {
	setAuthSessionSecret(testCookieSecret)
})

test('session handler renews remembered sessions after two weeks', async () => {
	const now = Date.UTC(2026, 1, 1)
	const cookie = await createAuthCookie(
		rememberedSession,
		false,
		now - 1000 * 60 * 60 * 24 * 15,
	)

	const response = await withMockedNow(now, () =>
		session.handler(createSessionRequestContext(cookie)),
	)

	expect(response.status).toBe(200)
	expect(response.headers.get('Set-Cookie')).toContain('Max-Age=2592000')
	await expect(response.json()).resolves.toEqual({
		ok: true,
		session: { email: rememberedSession.email },
	})
})

test('session handler keeps remembered sessions unchanged before renewal window', async () => {
	const now = Date.UTC(2026, 1, 1)
	const cookie = await createAuthCookie(
		rememberedSession,
		false,
		now - 1000 * 60 * 60 * 24 * 13,
	)

	const response = await withMockedNow(now, () =>
		session.handler(createSessionRequestContext(cookie)),
	)

	expect(response.status).toBe(200)
	expect(response.headers.get('Set-Cookie')).toBeNull()
	await expect(response.json()).resolves.toEqual({
		ok: true,
		session: { email: rememberedSession.email },
	})
})
