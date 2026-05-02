import { expect, test } from 'vitest'
import {
	decryptSecretValue,
	encryptSecretValue,
	encryptStringWithPurpose,
} from './crypto.ts'

const primaryKey = 'primary-secret-store-key-at-least-32-chars!!'
const cookieSecret = 'cookie-secret-value-at-least-32-characters!!'

test('encrypt then decrypt with SECRET_STORE_KEY succeeds', async () => {
	const env = { COOKIE_SECRET: cookieSecret, SECRET_STORE_KEY: primaryKey }
	const encrypted = await encryptSecretValue(env, 'my-secret-value')
	const result = await decryptSecretValue(env, encrypted)
	expect(result).toBe('my-secret-value')
})

test('decrypt with correct SECRET_STORE_KEY succeeds', async () => {
	const env = { COOKIE_SECRET: cookieSecret, SECRET_STORE_KEY: primaryKey }
	const encrypted = await encryptSecretValue(env, 'test-data')

	const result = await decryptSecretValue(env, encrypted)
	expect(result).toBe('test-data')
})

test('decryption fails when SECRET_STORE_KEY is wrong', async () => {
	const env = { COOKIE_SECRET: cookieSecret, SECRET_STORE_KEY: primaryKey }
	const encrypted = await encryptSecretValue(env, 'data')

	const wrongEnv = {
		SECRET_STORE_KEY: 'wrong-store-key-32-chars-minimum-value-here!!',
		COOKIE_SECRET: cookieSecret,
	}
	await expect(decryptSecretValue(wrongEnv, encrypted)).rejects.toThrow(
		'Unable to decrypt secret value.',
	)
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
