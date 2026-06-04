import { expect, test } from 'vitest'
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
