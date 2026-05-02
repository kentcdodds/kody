import { expect, test } from 'vitest'
import {
	decryptSecretValue,
	encryptSecretValue,
	encryptStringWithPurpose,
} from './crypto.ts'

const primaryKey = 'primary-secret-store-key-at-least-32-chars!!'
const cookieSecret = 'cookie-secret-value-at-least-32-characters!!'
const altCookieSecret = 'rotated-cookie-secret-at-least-32-characters!'

test('encrypt then decrypt with SECRET_STORE_KEY succeeds', async () => {
	const env = { COOKIE_SECRET: cookieSecret, SECRET_STORE_KEY: primaryKey }
	const encrypted = await encryptSecretValue(env, 'my-secret-value')
	const result = await decryptSecretValue(env, encrypted)
	expect(result.value).toBe('my-secret-value')
	expect(result.needsReEncrypt).toBe(false)
})

test('decrypt with correct SECRET_STORE_KEY ignores COOKIE_SECRET value', async () => {
	const env = { COOKIE_SECRET: cookieSecret, SECRET_STORE_KEY: primaryKey }
	const encrypted = await encryptSecretValue(env, 'test-data')

	const envWithDifferentCookie = {
		COOKIE_SECRET: altCookieSecret,
		SECRET_STORE_KEY: primaryKey,
	}
	const result = await decryptSecretValue(envWithDifferentCookie, encrypted)
	expect(result.value).toBe('test-data')
	expect(result.needsReEncrypt).toBe(false)
})

test('legacy ciphertext encrypted with COOKIE_SECRET decrypts via fallback', async () => {
	const legacyEnv = {
		COOKIE_SECRET: cookieSecret,
		SECRET_STORE_KEY: undefined,
	}
	const legacyCiphertext = await encryptSecretValue(legacyEnv, 'legacy-secret')

	const newEnv = { COOKIE_SECRET: cookieSecret, SECRET_STORE_KEY: primaryKey }
	const result = await decryptSecretValue(newEnv, legacyCiphertext)
	expect(result.value).toBe('legacy-secret')
	expect(result.needsReEncrypt).toBe(true)
})

test('rotating COOKIE_SECRET does not brick secrets when SECRET_STORE_KEY is stable', async () => {
	const env = { COOKIE_SECRET: cookieSecret, SECRET_STORE_KEY: primaryKey }
	const encrypted = await encryptSecretValue(env, 'important-data')

	const rotatedEnv = {
		COOKIE_SECRET: altCookieSecret,
		SECRET_STORE_KEY: primaryKey,
	}
	const result = await decryptSecretValue(rotatedEnv, encrypted)
	expect(result.value).toBe('important-data')
	expect(result.needsReEncrypt).toBe(false)
})

test('decryption fails when both keys are wrong', async () => {
	const env = { COOKIE_SECRET: cookieSecret, SECRET_STORE_KEY: primaryKey }
	const encrypted = await encryptSecretValue(env, 'data')

	const wrongEnv = {
		COOKIE_SECRET: 'wrong-cookie-secret-32-chars-minimum-value!!!',
		SECRET_STORE_KEY: 'wrong-store-key-32-chars-minimum-value-here!!',
	}
	await expect(decryptSecretValue(wrongEnv, encrypted)).rejects.toThrow(
		'Unable to decrypt secret value.',
	)
})

test('when SECRET_STORE_KEY is unset, encrypt/decrypt uses COOKIE_SECRET', async () => {
	const env = {
		COOKIE_SECRET: cookieSecret,
		SECRET_STORE_KEY: undefined,
	}
	const encrypted = await encryptSecretValue(env, 'fallback-test')
	const result = await decryptSecretValue(env, encrypted)
	expect(result.value).toBe('fallback-test')
	expect(result.needsReEncrypt).toBe(false)
})

test('general-purpose encrypt/decrypt with purpose uses COOKIE_SECRET', async () => {
	const env = { COOKIE_SECRET: cookieSecret, SECRET_STORE_KEY: primaryKey }
	const encrypted = await encryptStringWithPurpose(
		env,
		'test-purpose',
		'hello',
	)
	const { decryptStringWithPurpose } = await import('./crypto.ts')
	const decrypted = await decryptStringWithPurpose(env, 'test-purpose', encrypted)
	expect(decrypted).toBe('hello')
})

test('invalid payload format throws', async () => {
	const env = { COOKIE_SECRET: cookieSecret, SECRET_STORE_KEY: primaryKey }
	await expect(decryptSecretValue(env, 'no-dot-separator')).rejects.toThrow(
		'Invalid encrypted secret payload.',
	)
})
