import { expect, test } from 'vitest'
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

const cookieSecret = 'PACKAGE_APP_TEST_COOKIE_SECRET_32_CHARS_MINIMUM'

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
	userId: '17',
	username: 'owner',
	kodyId: 'daily-notes',
}

const expected = { username: claims.username, kodyId: claims.kodyId }

test('handoff tokens are single use, short lived, and bound to one user and package', async () => {
	const env = createTestEnv()

	const token = await createPackageAppHandoffToken({ env, claims })
	await expect(
		consumePackageAppHandoffToken({ env, token, expected }),
	).resolves.toStrictEqual(claims)

	// Burned on first use, so a token captured from browser history or a referrer
	// cannot be replayed.
	await expect(
		consumePackageAppHandoffToken({ env, token, expected }),
	).resolves.toBeNull()

	// Expired tokens fail closed, even unused ones.
	const staleToken = await createPackageAppHandoffToken({
		env,
		claims,
		now: Date.now() - 61_000,
	})
	await expect(
		consumePackageAppHandoffToken({ env, token: staleToken, expected }),
	).resolves.toBeNull()

	// Tampering with the payload (for example to point at another user's package)
	// invalidates the signature.
	const freshToken = await createPackageAppHandoffToken({ env, claims })
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
	const foreignToken = await createPackageAppHandoffToken({
		env: otherEnv,
		claims,
	})
	await expect(
		consumePackageAppHandoffToken({ env, token: foreignToken, expected }),
	).resolves.toBeNull()

	// A token aimed at another package (or another user) is refused *without*
	// being burned: it was never meant for this request, so a mistyped URL must
	// not cost the owner the handoff they still hold.
	const boundToken = await createPackageAppHandoffToken({ env, claims })
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
	).resolves.toStrictEqual(claims)

	// Replay protection needs KV; signature and expiry checks do not.
	const envWithoutKv = createTestEnv({ kv: false })
	const tokenWithoutKv = await createPackageAppHandoffToken({
		env: envWithoutKv,
		claims,
	})
	await expect(
		consumePackageAppHandoffToken({
			env: envWithoutKv,
			token: tokenWithoutKv,
			expected,
		}),
	).resolves.toStrictEqual(claims)
})

test('the package-app session cookie is not interchangeable with the app session cookie', async () => {
	resetPackageAppSessionCookieForTests()
	resetAuthSessionSecretForTests()
	const env = createTestEnv()

	const setCookie = await createPackageAppSessionCookie({
		env,
		session: { userId: '17', username: 'owner' },
		secure: true,
	})
	expect(setCookie).toContain('kody_pkg_session=')
	expect(setCookie).toContain('HttpOnly')
	expect(setCookie).toContain('SameSite=Lax')
	expect(setCookie).toContain('Secure')
	expect(setCookie).toContain('Path=/')

	const cookiePair = setCookie.split(';')[0] ?? ''
	const [, cookieValue] = cookiePair.split('=')
	expect(cookieValue).toBeTruthy()

	await expect(
		readPackageAppSession({
			request: new Request('https://kodyapps.dev/@owner/packages/x', {
				headers: { Cookie: cookiePair },
			}),
			env,
		}),
	).resolves.toMatchObject({
		session: { userId: '17', username: 'owner' },
	})

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
		{ id: '17', email: 'owner@example.com', rememberMe: false },
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
})
