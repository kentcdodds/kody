import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { expect, test } from 'vitest'
import { createCookie } from 'remix/cookie'
import {
	createAuthCookie,
	getAuthSessionExpiresAtMs,
	isAuthSessionExpired,
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
			stableUserId: ownerIdFromStored('1').repeat(64),
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
	expect(
		getAuthSessionExpiresAtMs({
			rememberMe: false,
			issuedAt: parsed?.issuedAt,
		}),
	).toBe(now + 7 * 24 * 60 * 60 * 1000)
	expect(
		getAuthSessionExpiresAtMs({
			rememberMe: true,
			issuedAt: now - 24 * 60 * 60 * 1000,
		}),
	).toBe(now + 29 * 24 * 60 * 60 * 1000)
})

test('absolute session lifetime rejects expired and legacy cookies', () => {
	const now = 1_700_000_000_000
	const dayMs = 24 * 60 * 60 * 1000
	const cases = [
		[false, now, false],
		[false, now - 8 * dayMs, true],
		[true, now - 8 * dayMs, false],
		[true, now - 31 * dayMs, true],
		[false, undefined, true],
	] as const
	expect(
		cases.map(([rememberMe, issuedAt]) =>
			isAuthSessionExpired({ rememberMe, issuedAt, now }),
		),
	).toEqual(cases.map(([, , expired]) => expired))
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
	expect(
		[null, '', '   ', 'not-a-timestamp'].map(parsePasswordChangedAtMs),
	).toEqual([null, null, null, null])

	const secondPrecisionChangedAt = parsePasswordChangedAtMs(
		'2026-07-25 12:00:00',
	)
	expect(secondPrecisionChangedAt).toBe(
		Date.parse('2026-07-25T12:00:00.000Z') + 999,
	)
	for (const changedAt of [
		'2026-07-25T12:00:00+00:00',
		'2026-07-25 12:00:00+00:00',
		'2026-07-25T12:00:00Z',
	]) {
		expect(parsePasswordChangedAtMs(changedAt)).toBe(
			Date.parse('2026-07-25T12:00:00Z') + 999,
		)
	}
	const msPrecisionChangedAt = parsePasswordChangedAtMs(
		'2026-07-25T12:00:00.400Z',
	)
	expect(msPrecisionChangedAt).toBe(Date.parse('2026-07-25T12:00:00.400Z'))

	const invalidationCases = [
		[undefined, null, false],
		[undefined, 100, true],
		[50, 100, true],
		[100, 100, true],
		[101, 100, false],
		[Date.parse('2026-07-25T12:00:00.500Z'), secondPrecisionChangedAt, true],
		[Date.parse('2026-07-25T12:00:01.000Z'), secondPrecisionChangedAt, false],
		[Date.parse('2026-07-25T12:00:00.300Z'), msPrecisionChangedAt, true],
		[Date.parse('2026-07-25T12:00:00.500Z'), msPrecisionChangedAt, false],
	] as const
	expect(
		invalidationCases.map(([issuedAt, passwordChangedAtMs]) =>
			isAuthSessionInvalidatedByPasswordChange({
				issuedAt,
				passwordChangedAtMs,
			}),
		),
	).toEqual(invalidationCases.map(([, , invalidated]) => invalidated))
})
