import { expect, test } from 'vitest'
import { createCookie } from 'remix/cookie'
import { sha256Base64Url } from '@kody-internal/shared/sha256.ts'
import {
	createAuthCookie,
	readParsedAuthSession,
	resetAuthSessionSecretForTests,
	setAuthSessionSecret,
} from '#app/auth-session.ts'
import {
	consumePackageAppHandoffToken,
	createPackageAppHandoffToken,
} from '#app/package-app-handoff.ts'
import {
	createPackageAppSessionCookie,
	readPackageAppSession,
	resetPackageAppSessionCookieForTests,
} from '#app/package-app-session.ts'
import {
	consoleWarn,
	silenceExpectedConsoleWarns,
} from '#worker/test-support/console-spies.ts'

const cookieSecret = 'PACKAGE_APP_TEST_COOKIE_SECRET_32_CHARS_MINIMUM'
const ownerStableUserId = '1'.repeat(64)

function createTestEnv(input: { cookieSecret?: string; kv?: boolean } = {}) {
	const store = new Map<string, string>()
	const kv = {
		get: async (key: string) => store.get(key) ?? null,
		put: async (key: string, value: string) => {
			store.set(key, value)
		},
	}
	return {
		COOKIE_SECRET: input.cookieSecret ?? cookieSecret,
		...(input.kv === false ? {} : { BUNDLE_ARTIFACTS_KV: kv }),
	} as unknown as Env
}

const claims = {
	stableUserId: ownerStableUserId,
	username: 'owner',
	kodyId: 'daily-notes',
}

const expected = { username: claims.username, kodyId: claims.kodyId }
const sessionExpiresAt = 1_800_000_000_000
const consumed = { ...claims, sessionExpiresAt }

function mintToken(
	env: Env,
	input: { now?: number; sessionExpiresAt?: number } = {},
) {
	return createPackageAppHandoffToken({
		env,
		claims,
		sessionExpiresAt: input.sessionExpiresAt ?? sessionExpiresAt,
		now: input.now,
	})
}

test('handoff tokens are single use, short lived, and bound to one user and package', async () => {
	silenceExpectedConsoleWarns(['Package app handoff rejected.'])
	const env = createTestEnv()

	const token = await mintToken(env)
	await expect(
		consumePackageAppHandoffToken({ env, token, expected }),
	).resolves.toStrictEqual(consumed)

	// Burned on first use, so a token captured from browser history or a referrer
	// cannot be replayed.
	await expect(
		consumePackageAppHandoffToken({ env, token, expected }),
	).resolves.toBeNull()
	expect(consoleWarn).toHaveBeenCalledWith('Package app handoff rejected.', {
		reason: 'replay',
	})

	// Expired tokens fail closed, even unused ones.
	const staleToken = await mintToken(env, { now: Date.now() - 61_000 })
	await expect(
		consumePackageAppHandoffToken({ env, token: staleToken, expected }),
	).resolves.toBeNull()

	// Tampering with the payload (for example to point at another user's package)
	// invalidates the signature.
	const freshToken = await mintToken(env)
	const [payload, signature] = freshToken.split('.')
	expect(payload).toBeTruthy()
	expect(signature).toBeTruthy()
	const decodedPayload: unknown = JSON.parse(
		Buffer.from(payload ?? '', 'base64url').toString('utf8'),
	)
	const forgedPayload = Buffer.from(
		JSON.stringify({
			...(decodedPayload as Record<string, unknown>),
			usr: 'attacker',
		}),
	).toString('base64url')
	for (const forged of [
		`${forgedPayload}.${signature}`,
		`${payload}.${signature}extra`,
		payload ?? '',
		`${payload}.${signature}.${signature}`,
		'not-a-token',
	]) {
		await expect(
			consumePackageAppHandoffToken({ env, token: forged, expected }),
		).resolves.toBeNull()
	}

	// A token minted under a different COOKIE_SECRET is not accepted.
	const otherEnv = createTestEnv({
		cookieSecret: 'ANOTHER_TEST_COOKIE_SECRET_32_CHARS_MINIMUM_OK',
	})
	const foreignToken = await mintToken(otherEnv)
	await expect(
		consumePackageAppHandoffToken({ env, token: foreignToken, expected }),
	).resolves.toBeNull()

	// A token aimed at another package (or another user) is refused *without*
	// being burned: it was never meant for this request, so a mistyped URL must
	// not cost the owner the handoff they still hold.
	const boundToken = await mintToken(env)
	for (const wrongTarget of [
		{ username: 'someone-else', kodyId: claims.kodyId },
		{ username: claims.username, kodyId: 'other-package' },
	]) {
		await expect(
			consumePackageAppHandoffToken({
				env,
				token: boundToken,
				expected: wrongTarget,
			}),
		).resolves.toBeNull()
	}
	await expect(
		consumePackageAppHandoffToken({ env, token: boundToken, expected }),
	).resolves.toStrictEqual(consumed)

	// Replay protection needs KV; signature and expiry checks do not.
	const envWithoutKv = createTestEnv({ kv: false })
	const tokenWithoutKv = await mintToken(envWithoutKv)
	await expect(
		consumePackageAppHandoffToken({
			env: envWithoutKv,
			token: tokenWithoutKv,
			expected,
		}),
	).resolves.toStrictEqual(consumed)

	// Missing COOKIE_SECRET must throw rather than look like an invalid token,
	// otherwise the visitor stays on the 403 page with `__kody_handoff` in the URL.
	await expect(
		consumePackageAppHandoffToken({
			env: createTestEnv({ cookieSecret: '' }),
			token: await mintToken(env),
			expected,
		}),
	).rejects.toThrow(/COOKIE_SECRET/)

	// A token whose parent session has already expired is refused even if the
	// one-minute handoff window is still open.
	const expiredParent = await mintToken(env, {
		sessionExpiresAt: Date.now() - 1,
	})
	await expect(
		consumePackageAppHandoffToken({ env, token: expiredParent, expected }),
	).resolves.toBeNull()

	// Less than one second of parent TTL cannot become a cookie Max-Age, so
	// consume refuses before burning the token.
	const now = Date.now()
	const subSecondParent = await mintToken(env, {
		sessionExpiresAt: now + 500,
	})
	await expect(
		consumePackageAppHandoffToken({
			env,
			token: subSecondParent,
			expected,
			now,
		}),
	).resolves.toBeNull()
})

test('the package-app session cookie is not interchangeable with the app session cookie', async () => {
	resetPackageAppSessionCookieForTests()
	resetAuthSessionSecretForTests()
	const env = createTestEnv()

	// Secure requests get the `__Host-` prefixed name, which browsers only
	// accept host-only (`Secure`, no `Domain`, `Path=/`): a sibling package-app
	// subdomain cannot toss a `Domain`-wide cookie under this name.
	const now = 1_700_000_000_000
	const threeHoursMs = 3 * 60 * 60 * 1000
	const expiresAt = now + threeHoursMs
	const setCookie = await createPackageAppSessionCookie({
		env,
		session: { stableUserId: ownerStableUserId, username: 'owner' },
		secure: true,
		now,
		expiresAt,
	})
	expect(setCookie).toContain('__Host-kody_pkg_session=')
	expect(setCookie).toContain('HttpOnly')
	expect(setCookie).toContain('SameSite=Lax')
	expect(setCookie).toContain('Secure')
	expect(setCookie).toContain('Path=/')
	expect(setCookie).toContain('Max-Age=10800')
	expect(setCookie).not.toContain('Domain=')

	const rememberMeSetCookie = await createPackageAppSessionCookie({
		env,
		session: { stableUserId: ownerStableUserId, username: 'owner' },
		secure: true,
		now,
		expiresAt: now + 30 * 24 * 60 * 60 * 1000,
	})
	expect(rememberMeSetCookie).toContain('Max-Age=2592000')

	// Plain-HTTP local development falls back to an unprefixed name because
	// browsers refuse `__Host-` cookies on insecure origins.
	const insecureSetCookie = await createPackageAppSessionCookie({
		env,
		session: { stableUserId: ownerStableUserId, username: 'owner' },
		secure: false,
		now,
		expiresAt,
	})
	expect(insecureSetCookie).toContain('kody_pkg_session=')
	expect(insecureSetCookie).not.toContain('__Host-')
	await expect(
		readPackageAppSession({
			request: new Request('http://owner.packages.localhost/packages/x', {
				headers: { Cookie: insecureSetCookie.split(';')[0] ?? '' },
			}),
			env,
			now,
		}),
	).resolves.toMatchObject({
		session: { stableUserId: ownerStableUserId, username: 'owner' },
	})

	const cookiePair = setCookie.split(';')[0] ?? ''
	const [, cookieValue] = cookiePair.split('=')
	expect(cookieValue).toBeTruthy()

	await expect(
		readPackageAppSession({
			request: new Request('https://owner.kodyapps.dev/packages/x', {
				headers: { Cookie: cookiePair },
			}),
			env,
			now,
		}),
	).resolves.toMatchObject({
		session: { stableUserId: ownerStableUserId, username: 'owner' },
		expiresAt,
	})
	await expect(
		readPackageAppSession({
			request: new Request('https://owner.kodyapps.dev/packages/x', {
				headers: { Cookie: cookiePair },
			}),
			env,
			now: expiresAt - 1,
		}),
	).resolves.toMatchObject({
		session: { stableUserId: ownerStableUserId, username: 'owner' },
	})
	await expect(
		readPackageAppSession({
			request: new Request('https://owner.kodyapps.dev/packages/x', {
				headers: { Cookie: cookiePair },
			}),
			env,
			now: expiresAt,
		}),
	).resolves.toBeNull()

	// Same secret material, different derived signing key: replaying the
	// package-app cookie value under the app session name does not authenticate.
	setAuthSessionSecret(cookieSecret)
	await expect(
		readParsedAuthSession(
			new Request('https://heykody.dev/account', {
				headers: { Cookie: `kody_session=${cookieValue}` },
			}),
		),
	).resolves.toBeNull()

	// And the reverse: an app session cookie value is not a package-app session.
	const appSetCookie = await createAuthCookie(
		{
			stableUserId: ownerStableUserId,
			email: 'owner@example.com',
			rememberMe: false,
		},
		true,
	)
	const appCookieValue = (appSetCookie.split(';')[0] ?? '').split('=')[1] ?? ''
	await expect(
		readPackageAppSession({
			request: new Request('https://kodyapps.dev/@owner/packages/x', {
				headers: { Cookie: `kody_pkg_session=${appCookieValue}` },
			}),
			env,
		}),
	).resolves.toBeNull()

	// Cookies minted before expiresAt existed keep the old 12 hour bound from
	// issuedAt, so a copied value cannot be replayed after that window.
	const legacyIssuedAt = now
	const legacyExpiresAt = legacyIssuedAt + 12 * 60 * 60 * 1000
	const legacyCookie = createCookie('kody_pkg_session', {
		httpOnly: true,
		sameSite: 'Lax',
		path: '/',
		secrets: [
			await sha256Base64Url(`kody-package-app-session:v2:${cookieSecret}`),
		],
	})
	const legacySetCookie = await legacyCookie.serialize(
		JSON.stringify({
			v: 2,
			stableUserId: ownerStableUserId,
			pkgUsername: 'owner',
			issuedAt: legacyIssuedAt,
		}),
	)
	const legacyPair = legacySetCookie.split(';')[0] ?? ''
	await expect(
		readPackageAppSession({
			request: new Request('http://owner.packages.localhost/packages/x', {
				headers: { Cookie: legacyPair },
			}),
			env,
			now: legacyExpiresAt - 1,
		}),
	).resolves.toMatchObject({
		session: { stableUserId: ownerStableUserId, username: 'owner' },
		expiresAt: legacyExpiresAt,
	})
	await expect(
		readPackageAppSession({
			request: new Request('http://owner.packages.localhost/packages/x', {
				headers: { Cookie: legacyPair },
			}),
			env,
			now: legacyExpiresAt,
		}),
	).resolves.toBeNull()
})
