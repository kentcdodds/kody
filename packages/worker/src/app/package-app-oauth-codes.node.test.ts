import { expect, test } from 'vitest'
import {
	consumePackageAppOauthCode,
	mintPackageAppOauthCode,
} from '#app/package-app-oauth-codes.ts'
import { createS256CodeChallenge } from '#app/package-app-oauth-pkce-cookie.ts'
import { sha256Base64Url } from '@kody-internal/shared/sha256.ts'

function createTestEnv() {
	const store = new Map<string, string>()
	return {
		BUNDLE_ARTIFACTS_KV: {
			get: async (key: string) => store.get(key) ?? null,
			put: async (key: string, value: string) => {
				store.set(key, value)
			},
			delete: async (key: string) => {
				store.delete(key)
			},
		},
	} as unknown as Env
}

test('package-app OAuth codes are single-use, PKCE-bound, and redirect-bound', async () => {
	const env = createTestEnv()
	const verifier = 'test-verifier-value-32chars-minimum!!'
	const challenge = await createS256CodeChallenge(verifier)
	expect(challenge).toBe(await sha256Base64Url(verifier))

	const minted = await mintPackageAppOauthCode({
		env,
		record: {
			personId: '1'.repeat(64),
			username: 'visitor',
			orgUsername: 'owner',
			kodyId: 'demo',
			redirectUri: 'https://owner.kody.run/_kody/auth/callback',
			codeChallenge: challenge,
			scopes: ['profile'],
			sessionExpiresAt: Date.now() + 60_000,
		},
	})
	expect(minted?.code).toBeTruthy()

	const consumed = await consumePackageAppOauthCode({
		env,
		code: minted!.code,
		redirectUri: 'https://owner.kody.run/_kody/auth/callback',
		codeVerifier: verifier,
	})
	expect(consumed?.orgUsername).toBe('owner')
	expect(consumed?.kodyId).toBe('demo')

	await expect(
		consumePackageAppOauthCode({
			env,
			code: minted!.code,
			redirectUri: 'https://owner.kody.run/_kody/auth/callback',
			codeVerifier: verifier,
		}),
	).resolves.toBeNull()

	const second = await mintPackageAppOauthCode({
		env,
		record: {
			personId: '1'.repeat(64),
			username: 'visitor',
			orgUsername: 'owner',
			kodyId: 'demo',
			redirectUri: 'https://owner.kody.run/_kody/auth/callback',
			codeChallenge: challenge,
			scopes: ['profile'],
			sessionExpiresAt: Date.now() + 60_000,
		},
	})
	await expect(
		consumePackageAppOauthCode({
			env,
			code: second!.code,
			redirectUri: 'https://evil.example/_kody/auth/callback',
			codeVerifier: verifier,
		}),
	).resolves.toBeNull()

	const third = await mintPackageAppOauthCode({
		env,
		record: {
			personId: '1'.repeat(64),
			username: 'visitor',
			orgUsername: 'owner',
			kodyId: 'demo',
			redirectUri: 'https://owner.kody.run/_kody/auth/callback',
			codeChallenge: challenge,
			scopes: ['profile'],
			sessionExpiresAt: Date.now() + 60_000,
		},
	})
	await expect(
		consumePackageAppOauthCode({
			env,
			code: third!.code,
			redirectUri: 'https://owner.kody.run/_kody/auth/callback',
			codeVerifier: 'wrong-verifier',
		}),
	).resolves.toBeNull()
})
