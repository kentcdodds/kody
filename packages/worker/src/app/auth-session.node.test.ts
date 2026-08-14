import { expect, test } from 'vitest'
import { createCookie } from 'remix/cookie'
import {
	createAuthCookie,
	isAuthSessionInvalidatedByPasswordChange,
	readParsedAuthSession,
	setAuthSessionSecret,
} from '#app/auth-session.ts'
import { parsePasswordChangedAtMs } from '#app/request-auth-cache.ts'

const testCookieSecret = 'test-cookie-secret-0123456789abcdef0123456789'

test('createAuthCookie stamps issuedAt for password-change invalidation', async () => {
	setAuthSessionSecret(testCookieSecret)
	const now = 1_700_000_000_000
	const cookie = await createAuthCookie(
		{
			stableUserId: '1'.repeat(64),
			email: 'user@example.com',
			rememberMe: false,
		},
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

test('legacy numeric-id session cookies fail closed', async () => {
	setAuthSessionSecret(testCookieSecret)
	const legacyCookie = createCookie('kody_session', {
		httpOnly: true,
		sameSite: 'Lax',
		path: '/',
		secrets: [testCookieSecret],
	})
	const cookie = await legacyCookie.serialize(
		JSON.stringify({
			id: '42',
			email: 'user@example.com',
			rememberMe: false,
			issuedAt: Date.now(),
		}),
	)
	const request = new Request('https://example.com/', {
		headers: { Cookie: cookie.split(';')[0]! },
	})

	await expect(readParsedAuthSession(request)).resolves.toBeNull()
})

test('password-change invalidation covers legacy cookies, second-precision SQLite, and re-login', () => {
	expect(parsePasswordChangedAtMs(null)).toBeNull()
	expect(parsePasswordChangedAtMs('')).toBeNull()
	expect(parsePasswordChangedAtMs('   ')).toBeNull()
	expect(parsePasswordChangedAtMs('not-a-timestamp')).toBeNull()

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

	const secondPrecisionChangedAt = parsePasswordChangedAtMs(
		'2026-07-25 12:00:00',
	)
	expect(secondPrecisionChangedAt).toBe(
		Date.parse('2026-07-25T12:00:00.000Z') + 999,
	)
	expect(
		isAuthSessionInvalidatedByPasswordChange({
			issuedAt: Date.parse('2026-07-25T12:00:00.500Z'),
			passwordChangedAtMs: secondPrecisionChangedAt,
		}),
	).toBe(true)
	expect(
		isAuthSessionInvalidatedByPasswordChange({
			issuedAt: Date.parse('2026-07-25T12:00:01.000Z'),
			passwordChangedAtMs: secondPrecisionChangedAt,
		}),
	).toBe(false)

	const msPrecisionChangedAt = parsePasswordChangedAtMs(
		'2026-07-25T12:00:00.400Z',
	)
	expect(msPrecisionChangedAt).toBe(Date.parse('2026-07-25T12:00:00.400Z'))
	expect(
		isAuthSessionInvalidatedByPasswordChange({
			issuedAt: Date.parse('2026-07-25T12:00:00.300Z'),
			passwordChangedAtMs: msPrecisionChangedAt,
		}),
	).toBe(true)
	expect(
		isAuthSessionInvalidatedByPasswordChange({
			issuedAt: Date.parse('2026-07-25T12:00:00.500Z'),
			passwordChangedAtMs: msPrecisionChangedAt,
		}),
	).toBe(false)
})
