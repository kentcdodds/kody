import { expect, test, vi } from 'vitest'
import {
	decryptPlatformOauthClientSecret,
	decryptSecretValue,
	decryptStringWithPurpose,
	encryptSecretValue,
	encryptPlatformOauthClientSecret,
	encryptStringWithPurpose,
	platformOauthAppContext,
	userSecretContext,
} from './crypto.ts'

const primaryKey = 'primary-secret-store-key-at-least-32-chars!!'
const cookieSecret = 'cookie-secret-value-at-least-32-characters!!'

test('secret and purpose-based encryption round-trip and reject wrong keys or malformed payloads', async () => {
	const env = { COOKIE_SECRET: cookieSecret, SECRET_STORE_KEY: primaryKey }
	const context = userSecretContext('user-1')
	const encrypted = await encryptSecretValue(env, 'my-secret-value', context)
	expect(encrypted.startsWith('v2.')).toBe(true)
	expect(await decryptSecretValue(env, encrypted, context)).toBe(
		'my-secret-value',
	)

	const wrongEnv = {
		SECRET_STORE_KEY: 'wrong-store-key-32-chars-minimum-value-here!!',
		COOKIE_SECRET: cookieSecret,
	}
	await expect(
		decryptSecretValue(wrongEnv, encrypted, context),
	).rejects.toThrow('Unable to decrypt secret value.')
	await expect(
		decryptSecretValue(env, 'no-dot-separator', context),
	).rejects.toThrow('Unable to decrypt secret value.')

	const purposeEncrypted = await encryptStringWithPurpose(
		env,
		'test-purpose',
		'hello',
	)
	expect(
		await decryptStringWithPurpose(env, 'test-purpose', purposeEncrypted),
	).toBe('hello')
})

test('secret AAD/versioning binds identity context, platform OAuth slugs, and still decrypts legacy payloads', async () => {
	const env = { COOKIE_SECRET: cookieSecret, SECRET_STORE_KEY: primaryKey }
	const encrypted = await encryptSecretValue(
		env,
		'bound-value',
		userSecretContext('user-a'),
	)

	// Same key, different owner: the row-swap defense must reject it.
	await expect(
		decryptSecretValue(env, encrypted, userSecretContext('user-b')),
	).rejects.toThrow('Unable to decrypt secret value.')

	// Tampered ciphertext bytes must be rejected.
	const [version, iv, ciphertext] = encrypted.split('.')
	const tamperedByte = ciphertext![0] === 'A' ? 'B' : 'A'
	const tampered = `${version}.${iv}.${tamperedByte}${ciphertext!.slice(1)}`
	await expect(
		decryptSecretValue(env, tampered, userSecretContext('user-a')),
	).rejects.toThrow('Unable to decrypt secret value.')

	// Unknown version tags must be rejected.
	await expect(
		decryptSecretValue(
			env,
			`v3.${iv}.${ciphertext}`,
			userSecretContext('user-a'),
		),
	).rejects.toThrow('Unable to decrypt secret value.')

	const platformEncrypted = await encryptPlatformOauthClientSecret(
		{ SECRET_STORE_KEY: primaryKey },
		'client-secret-value',
		platformOauthAppContext('one'),
	)
	expect(
		await decryptPlatformOauthClientSecret(
			{ SECRET_STORE_KEY: primaryKey },
			platformEncrypted,
			platformOauthAppContext('one'),
		),
	).toBe('client-secret-value')
	await expect(
		decryptPlatformOauthClientSecret(
			{ SECRET_STORE_KEY: primaryKey },
			platformEncrypted,
			platformOauthAppContext('two'),
		),
	).rejects.toThrow('Unable to decrypt platform client secret.')

	// Reproduce the pre-v2 format: AES-GCM with no AAD, `<iv>.<ciphertext>`.
	const digest = await crypto.subtle.digest(
		'SHA-256',
		new TextEncoder().encode(`mcp-secret-store:${primaryKey}`),
	)
	const key = await crypto.subtle.importKey('raw', digest, 'AES-GCM', false, [
		'encrypt',
	])
	const legacyIv = crypto.getRandomValues(new Uint8Array(12))
	const legacyCiphertext = new Uint8Array(
		await crypto.subtle.encrypt(
			{ name: 'AES-GCM', iv: legacyIv },
			key,
			new TextEncoder().encode('legacy-value'),
		),
	)
	const toBase64Url = (bytes: Uint8Array) =>
		btoa(String.fromCharCode(...bytes))
			.replaceAll('+', '-')
			.replaceAll('/', '_')
			.replace(/=+$/, '')
	const legacyPayload = `${toBase64Url(legacyIv)}.${toBase64Url(legacyCiphertext)}`

	expect(
		await decryptSecretValue(env, legacyPayload, userSecretContext('user-a')),
	).toBe('legacy-value')
	expect(
		await decryptSecretValue(env, legacyPayload, userSecretContext('user-b')),
	).toBe('legacy-value')
})

test('secret store CryptoKey derivation is cached across encrypt and decrypt', async () => {
	const cacheTestKey = 'cache-test-secret-store-key-32-chars-min!!'
	const env = { COOKIE_SECRET: cookieSecret, SECRET_STORE_KEY: cacheTestKey }
	const derivedKeys: Array<CryptoKey> = []
	const originalImportKey = crypto.subtle.importKey.bind(crypto.subtle)
	const importKeySpy = vi
		.spyOn(crypto.subtle, 'importKey')
		.mockImplementation(async (...args) => {
			const key = await originalImportKey(
				...(args as Parameters<typeof crypto.subtle.importKey>),
			)
			derivedKeys.push(key)
			return key
		})
	const digestSpy = vi.spyOn(crypto.subtle, 'digest')

	try {
		const context = userSecretContext('user-1')
		const encrypted = await encryptSecretValue(env, 'cached-value', context)
		const digestCallsAfterEncrypt = digestSpy.mock.calls.length
		const importKeyCallsAfterEncrypt = importKeySpy.mock.calls.length

		expect(await decryptSecretValue(env, encrypted, context)).toBe(
			'cached-value',
		)
		expect(digestSpy.mock.calls.length).toBe(digestCallsAfterEncrypt)
		expect(importKeySpy.mock.calls.length).toBe(importKeyCallsAfterEncrypt)
		expect(derivedKeys).toHaveLength(1)

		await encryptSecretValue(env, 'another-value', context)
		expect(digestSpy.mock.calls.length).toBe(digestCallsAfterEncrypt)
		expect(importKeySpy.mock.calls.length).toBe(importKeyCallsAfterEncrypt)
		expect(derivedKeys).toHaveLength(1)
	} finally {
		importKeySpy.mockRestore()
		digestSpy.mockRestore()
	}
})

test('failed secret store CryptoKey derivation is not cached', async () => {
	const failureTestKey = 'failure-test-secret-store-key-32-chars-min!'
	const env = { COOKIE_SECRET: cookieSecret, SECRET_STORE_KEY: failureTestKey }
	let attempts = 0
	const originalImportKey = crypto.subtle.importKey.bind(crypto.subtle)
	const importKeySpy = vi
		.spyOn(crypto.subtle, 'importKey')
		.mockImplementation(async (...args) => {
			attempts += 1
			if (attempts === 1) {
				throw new Error('transient derivation failure')
			}
			return originalImportKey(
				...(args as Parameters<typeof crypto.subtle.importKey>),
			)
		})

	try {
		const context = userSecretContext('user-1')
		await expect(encryptSecretValue(env, 'fail', context)).rejects.toThrow(
			'transient derivation failure',
		)
		const encrypted = await encryptSecretValue(env, 'ok', context)
		expect(await decryptSecretValue(env, encrypted, context)).toBe('ok')
		expect(attempts).toBe(2)
	} finally {
		importKeySpy.mockRestore()
	}
})
