import { expect, test } from 'vitest'
import {
	consumePackageAppOauthCode,
	mintPackageAppOauthCode,
} from '#app/package-app-oauth-codes.ts'
import { createS256CodeChallenge } from '#app/package-app-oauth-pkce-cookie.ts'
import { sha256Base64Url } from '@kody-internal/shared/sha256.ts'

function createTestEnv() {
	const rows = new Map<string, { payload: string; expiresAt: string }>()
	const db = {
		prepare(sql: string) {
			const binds: Array<unknown> = []
			const stmt = {
				bind(...args: Array<unknown>) {
					binds.push(...args)
					return stmt
				},
				async run() {
					if (sql.includes('INSERT INTO package_app_oauth_codes')) {
						rows.set(String(binds[0]), {
							payload: String(binds[1]),
							expiresAt: String(binds[2]),
						})
					}
					return { success: true }
				},
				async first<T>() {
					if (sql.includes('DELETE FROM package_app_oauth_codes')) {
						const hash = String(binds[0])
						const nowIso = String(binds[1])
						const row = rows.get(hash)
						if (!row || row.expiresAt <= nowIso) return null
						rows.delete(hash)
						return { payload: row.payload } as T
					}
					return null
				},
			}
			return stmt
		},
	}
	return { APP_DB: db } as unknown as Env
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
