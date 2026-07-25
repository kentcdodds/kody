import { expect, test } from 'vitest'
import {
	createAuthCookie,
	isAuthSessionInvalidatedByPasswordChange,
	readParsedAuthSession,
	setAuthSessionSecret,
} from '#app/auth-session.ts'

const testCookieSecret = 'test-cookie-secret-0123456789abcdef0123456789'

test('createAuthCookie always stamps issuedAt for password-change checks', async () => {
	setAuthSessionSecret(testCookieSecret)
	const now = 1_700_000_000_000
	const cookie = await createAuthCookie(
		{ id: '1', email: 'user@example.com', rememberMe: false },
		false,
		now,
	)
	const request = new Request('https://example.com/', {
		headers: { Cookie: cookie.split(';')[0]! },
	})
	const parsed = await readParsedAuthSession(request, now)
	expect(parsed?.issuedAt).toBe(now)
	expect(parsed?.session.rememberMe).toBe(false)
})

test('isAuthSessionInvalidatedByPasswordChange fails closed for legacy cookies', () => {
	expect(
		isAuthSessionInvalidatedByPasswordChange({
			issuedAt: undefined,
			passwordChangedAtMs: null,
		}),
	).toBe(false)
	expect(
		isAuthSessionInvalidatedByPasswordChange({
			issuedAt: undefined,
			passwordChangedAtMs: 100,
		}),
	).toBe(true)
	expect(
		isAuthSessionInvalidatedByPasswordChange({
			issuedAt: 50,
			passwordChangedAtMs: 100,
		}),
	).toBe(true)
	expect(
		isAuthSessionInvalidatedByPasswordChange({
			issuedAt: 100,
			passwordChangedAtMs: 100,
		}),
	).toBe(true)
	expect(
		isAuthSessionInvalidatedByPasswordChange({
			issuedAt: 101,
			passwordChangedAtMs: 100,
		}),
	).toBe(false)
})
