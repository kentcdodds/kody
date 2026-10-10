import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { expect, test, vi } from 'vitest'
import {
	decryptPlatformOauthClientSecret,
	decryptSecretValue,
	encryptSecretValue,
	encryptPlatformOauthClientSecret,
	encryptWebhookUrlSecret,
	decryptWebhookUrlSecret,
	platformOauthAppContext,
	userSecretContext,
	userWebhookUrlSecretContext,
} from './crypto.ts'

const primaryKey = 'primary-secret-store-key-at-least-32-chars!!'

test('secret encryption round-trips and binds AAD, versioning, platform OAuth slugs, and webhook endpoints', async () => {
	const env = { SECRET_STORE_KEY: primaryKey }
	const encrypted = await encryptSecretValue(
		env,
		'bound-value',
		userSecretContext(ownerIdFromStored('user-a')),
	)
	expect(encrypted.startsWith('v2.')).toBe(true)
	expect(
		await decryptSecretValue(
			env,
			encrypted,
			userSecretContext(ownerIdFromStored('user-a')),
		),
	).toBe('bound-value')

	const [version, iv, ciphertext] = encrypted.split('.')
	const tamperedByte = ciphertext![0] === 'A' ? 'B' : 'A'
	const rejectedDecrypts = [
		{
			label: 'wrong store key',
			env: {
				SECRET_STORE_KEY: 'wrong-store-key-32-chars-minimum-value-here!!',
			},
			payload: encrypted,
		},
		{ label: 'malformed payload', payload: 'no-dot-separator' },
		// Same key, different owner: the row-swap defense must reject it.
		{
			label: 'other owner',
			payload: encrypted,
			userId: ownerIdFromStored('user-b'),
		},
		{
			label: 'tampered ciphertext',
			payload: `${version}.${iv}.${tamperedByte}${ciphertext!.slice(1)}`,
		},
		{ label: 'unknown version', payload: `v3.${iv}.${ciphertext}` },
		{ label: 'missing version', payload: `${iv}.${ciphertext}` },
	]
	for (const rejected of rejectedDecrypts) {
		const error = await decryptSecretValue(
			rejected.env ?? env,
			rejected.payload,
			userSecretContext(rejected.userId ?? ownerIdFromStored('user-a')),
		).catch((caught: unknown) => caught)
		expect({
			label: rejected.label,
			message: (error as Error).message,
		}).toEqual({
			label: rejected.label,
			message: 'Unable to decrypt secret value.',
		})
	}

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

	const webhookContext = userWebhookUrlSecretContext(
		ownerIdFromStored('user-a'),
		'endpoint-1',
	)
	const webhookEncrypted = await encryptWebhookUrlSecret(
		env,
		'webhook-url-secret',
		webhookContext,
	)
	expect(
		await decryptWebhookUrlSecret(env, webhookEncrypted, webhookContext),
	).toBe('webhook-url-secret')
	await expect(
		decryptWebhookUrlSecret(
			env,
			webhookEncrypted,
			userWebhookUrlSecretContext(ownerIdFromStored('user-a'), 'endpoint-2'),
		),
	).rejects.toThrow('Unable to decrypt webhook URL secret.')
})

test('secret store CryptoKey derivation is cached across encrypt and decrypt', async () => {
	const cacheTestKey = 'cache-test-secret-store-key-32-chars-min!!'
	const env = { SECRET_STORE_KEY: cacheTestKey }
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
		const context = userSecretContext(ownerIdFromStored('user-1'))
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
	const env = { SECRET_STORE_KEY: failureTestKey }
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
		const context = userSecretContext(ownerIdFromStored('user-1'))
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
