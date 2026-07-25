import { expect, test } from 'vitest'
import {
	createAuthCookie,
	isAuthSessionInvalidatedByPasswordChange,
	readParsedAuthSession,
	setAuthSessionSecret,
} from '#app/auth-session.ts'
import { parsePasswordChangedAtMs } from '#app/request-auth-cache.ts'

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

test('second-precision password_changed_at invalidates cookies later in the same second', () => {
	const changedAtMs = parsePasswordChangedAtMs('2026-07-25 12:00:00')
	expect(changedAtMs).toBe(Date.parse('2026-07-25T12:00:00.000Z') + 999)
	expect(
		isAuthSessionInvalidatedByPasswordChange({
			issuedAt: Date.parse('2026-07-25T12:00:00.500Z'),
			passwordChangedAtMs: changedAtMs,
		}),
	).toBe(true)
	expect(
		isAuthSessionInvalidatedByPasswordChange({
			issuedAt: Date.parse('2026-07-25T12:00:01.000Z'),
			passwordChangedAtMs: changedAtMs,
		}),
	).toBe(false)
})

test('millisecond password_changed_at allows same-second re-login after reset', () => {
	const changedAtMs = parsePasswordChangedAtMs('2026-07-25T12:00:00.400Z')
	expect(changedAtMs).toBe(Date.parse('2026-07-25T12:00:00.400Z'))
	expect(
		isAuthSessionInvalidatedByPasswordChange({
			issuedAt: Date.parse('2026-07-25T12:00:00.300Z'),
			passwordChangedAtMs: changedAtMs,
		}),
	).toBe(true)
	expect(
		isAuthSessionInvalidatedByPasswordChange({
			issuedAt: Date.parse('2026-07-25T12:00:00.500Z'),
			passwordChangedAtMs: changedAtMs,
		}),
	).toBe(false)
})

test('parsePasswordChangedAtMs returns null for empty or malformed values', () => {
	expect(parsePasswordChangedAtMs(null)).toBeNull()
	expect(parsePasswordChangedAtMs('')).toBeNull()
	expect(parsePasswordChangedAtMs('   ')).toBeNull()
	expect(parsePasswordChangedAtMs('not-a-timestamp')).toBeNull()
})
