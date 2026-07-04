import { expect, test, vi } from 'vitest'
import {
	decryptSecretValue,
	decryptStringWithPurpose,
	encryptSecretValue,
	encryptStringWithPurpose,
} from './crypto.ts'

const primaryKey = 'primary-secret-store-key-at-least-32-chars!!'
const cookieSecret = 'cookie-secret-value-at-least-32-characters!!'

test('secret and purpose-based encryption round-trip and reject wrong keys or malformed payloads', async () => {
	const env = { COOKIE_SECRET: cookieSecret, SECRET_STORE_KEY: primaryKey }
	const encrypted = await encryptSecretValue(env, 'my-secret-value')
	expect(await decryptSecretValue(env, encrypted)).toBe('my-secret-value')

	const wrongEnv = {
		SECRET_STORE_KEY: 'wrong-store-key-32-chars-minimum-value-here!!',
		COOKIE_SECRET: cookieSecret,
	}
	await expect(decryptSecretValue(wrongEnv, encrypted)).rejects.toThrow(
		'Unable to decrypt secret value.',
	)
	await expect(decryptSecretValue(env, 'no-dot-separator')).rejects.toThrow(
		'Invalid encrypted secret payload.',
	)

	const purposeEncrypted = await encryptStringWithPurpose(
		env,
		'test-purpose',
		'hello',
	)
	expect(
		await decryptStringWithPurpose(env, 'test-purpose', purposeEncrypted),
	).toBe('hello')
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
		const encrypted = await encryptSecretValue(env, 'cached-value')
		const digestCallsAfterEncrypt = digestSpy.mock.calls.length
		const importKeyCallsAfterEncrypt = importKeySpy.mock.calls.length

		expect(await decryptSecretValue(env, encrypted)).toBe('cached-value')
		expect(digestSpy.mock.calls.length).toBe(digestCallsAfterEncrypt)
		expect(importKeySpy.mock.calls.length).toBe(importKeyCallsAfterEncrypt)
		expect(derivedKeys).toHaveLength(1)

		await encryptSecretValue(env, 'another-value')
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
		await expect(encryptSecretValue(env, 'fail')).rejects.toThrow(
			'transient derivation failure',
		)
		const encrypted = await encryptSecretValue(env, 'ok')
		expect(await decryptSecretValue(env, encrypted)).toBe('ok')
		expect(attempts).toBe(2)
	} finally {
		importKeySpy.mockRestore()
	}
})
