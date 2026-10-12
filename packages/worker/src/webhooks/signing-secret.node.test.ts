import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { DatabaseSync } from 'node:sqlite'
import { expect, test, vi } from 'vitest'
import {
	decryptWebhookHmacSecret,
	encryptWebhookHmacSecret,
	userWebhookHmacSecretContext,
} from '#mcp/secrets/crypto.ts'
import { applyAllMigrations } from '#worker/test-support/apply-all-migrations.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { provisionPersonalOrgForSqliteUser } from '#worker/test-support/personal-org-seed.ts'
import { sessionRequestContext } from '#worker/test-support/request-context.ts'
import { consoleWarn } from '#worker/test-support/console-spies.ts'
import {
	resolveHmacCiphertextForMint,
	resolveWebhookHmacSigningSecret,
	resolveWebhookHmacVerificationSecrets,
	shouldMintPackageOwnedWebhookHmac,
} from './signing-secret.ts'
import { type WebhookEndpointRecord } from './types.ts'

vi.mock('#mcp/secrets/service.ts', () => {
	const resolveSecret = vi.fn(async (_input: unknown) => ({
		found: true,
		credentialId: 'cred-legacy-webhook-secret',
		value: 'legacy-secret-store-value',
		allowedHosts: [],
		allowedPackages: ['pkg-1'],
		scope: 'user',
	}))
	return {
		resolveSecret,
		findSecretForUse: vi.fn(async (input: unknown) => {
			const resolved = await resolveSecret(input)
			const { value: _value, ...found } = resolved
			return { found, readValue: async () => resolved }
		}),
	}
})

const { resolveSecret, findSecretForUse } =
	await import('#mcp/secrets/service.ts')

function endpoint(
	overrides: Partial<WebhookEndpointRecord> = {},
): WebhookEndpointRecord {
	return {
		id: 'ep-1',
		userId: ownerIdFromStored('user-1'),
		packageId: 'pkg-1',
		webhookName: 'github',
		urlSecretHash: 'hash',
		urlSecretEncrypted: 'url-cipher',
		hmacSecretEncrypted: null,
		previousUrlSecretHash: null,
		previousUrlSecretExpiresAt: null,
		enabled: true,
		createdAt: '2026-07-24T00:00:00.000Z',
		rotatedAt: '2026-07-24T00:00:00.000Z',
		...overrides,
	}
}

test('shouldMintPackageOwnedWebhookHmac only when verification omits secretName', () => {
	expect(shouldMintPackageOwnedWebhookHmac(null)).toBe(false)
	expect(
		shouldMintPackageOwnedWebhookHmac({
			type: 'hmac-sha256',
			header: 'x-hub-signature-256',
			encoding: 'hex',
			secretName: 'githubWebhookSecret',
		}),
	).toBe(false)
	expect(
		shouldMintPackageOwnedWebhookHmac({
			type: 'hmac-sha256',
			header: 'x-hub-signature-256',
			encoding: 'hex',
		}),
	).toBe(true)
})

const env = {
	APP_DB: {} as D1Database,
	SECRET_STORE_KEY: 'test-secret-store-key-32-chars-minimum',
} as Env

const stripeVerification = {
	type: 'hmac-sha256',
	header: 'stripe-signature',
	encoding: 'hex',
	secretName: 'stripeWebhookSecretCancelFarewell',
} as const

async function storedCiphertext(plaintext: string) {
	return encryptWebhookHmacSecret(
		env,
		plaintext,
		userWebhookHmacSecretContext(ownerIdFromStored('user-1'), 'ep-1'),
	)
}

test('apply injects the package-owned ciphertext and never looks up secretName live', async () => {
	vi.mocked(resolveSecret).mockClear()
	const value = await resolveWebhookHmacSigningSecret({
		env,
		userId: ownerIdFromStored('user-1'),
		endpoint: endpoint({
			hmacSecretEncrypted: await storedCiphertext('package-owned-hmac-value'),
		}),
	})
	expect(value).toBe('package-owned-hmac-value')
	await expect(
		resolveWebhookHmacSigningSecret({
			env,
			userId: ownerIdFromStored('user-1'),
			endpoint: endpoint(),
		}),
	).rejects.toThrow(/package-owned signing secret/)
	expect(resolveSecret).not.toHaveBeenCalled()
})

test('inbound verification tries a declared secretName before the stored generated secret', async () => {
	vi.mocked(resolveSecret).mockClear()
	const secrets = await resolveWebhookHmacVerificationSecrets({
		env,
		userId: ownerIdFromStored('user-1'),
		endpoint: endpoint({
			hmacSecretEncrypted: await storedCiphertext(
				'kody-generated-at-migration',
			),
		}),
		verification: stripeVerification,
	})
	expect(secrets).toEqual([
		{ value: 'legacy-secret-store-value', source: 'declared' },
		{ value: 'kody-generated-at-migration', source: 'stored' },
	])
	expect(resolveSecret).toHaveBeenCalledWith(
		expect.objectContaining({ name: 'stripeWebhookSecretCancelFarewell' }),
	)
})

test('inbound verification lists a stored copy of the declared secret once', async () => {
	const secrets = await resolveWebhookHmacVerificationSecrets({
		env,
		userId: ownerIdFromStored('user-1'),
		endpoint: endpoint({
			hmacSecretEncrypted: await storedCiphertext('legacy-secret-store-value'),
		}),
		verification: stripeVerification,
	})
	expect(secrets).toEqual([
		{ value: 'legacy-secret-store-value', source: 'declared' },
	])
})

test('inbound verification keeps the stored secret when the declared one cannot be read', async () => {
	consoleWarn.mockImplementation(() => {})
	vi.mocked(findSecretForUse).mockRejectedValueOnce(new Error('not found'))
	const secrets = await resolveWebhookHmacVerificationSecrets({
		env,
		userId: ownerIdFromStored('user-1'),
		endpoint: endpoint({
			hmacSecretEncrypted: await storedCiphertext(
				'kody-generated-at-migration',
			),
		}),
		verification: stripeVerification,
	})
	expect(secrets).toEqual([
		{ value: 'kody-generated-at-migration', source: 'stored' },
	])
	expect(consoleWarn).toHaveBeenCalledWith(
		'webhook-declared-secret-resolve-failed',
		expect.objectContaining({
			secretName: 'stripeWebhookSecretCancelFarewell',
		}),
	)

	vi.mocked(findSecretForUse).mockRejectedValueOnce(new Error('not found'))
	await expect(
		resolveWebhookHmacVerificationSecrets({
			env,
			userId: ownerIdFromStored('user-1'),
			endpoint: endpoint(),
			verification: stripeVerification,
		}),
	).rejects.toThrow(/stripeWebhookSecretCancelFarewell/)
})

test('inbound verification without secretName uses the stored secret and no lookup', async () => {
	vi.mocked(resolveSecret).mockClear()
	const { secretName: _secretName, ...withoutName } = stripeVerification
	expect(
		await resolveWebhookHmacVerificationSecrets({
			env,
			userId: ownerIdFromStored('user-1'),
			endpoint: endpoint({
				hmacSecretEncrypted: await storedCiphertext('package-owned-hmac'),
			}),
			verification: withoutName,
		}),
	).toEqual([{ value: 'package-owned-hmac', source: 'stored' }])
	expect(resolveSecret).not.toHaveBeenCalled()
})

test('resolveHmacCiphertextForMint copies legacy secretName onto the endpoint', async () => {
	const sqlite = new DatabaseSync(':memory:')
	applyAllMigrations(sqlite, new URL('../../migrations/', import.meta.url))
	await provisionPersonalOrgForSqliteUser(sqlite, {
		stableUserId: 'user-1',
		username: 'ada',
	})
	const db = createD1FromSqlite(sqlite)
	const env = {
		APP_DB: db,
		SECRET_STORE_KEY: 'test-secret-store-key-32-chars-minimum',
	} as Env
	vi.mocked(resolveSecret).mockClear()
	const encrypted = await resolveHmacCiphertextForMint({
		env,
		request: sessionRequestContext('user-1', 'ada'),
		baseUrl: 'https://example.com',
		userId: ownerIdFromStored('user-1'),
		endpointId: 'ep-1',
		packageId: 'pkg-1',
		verification: {
			type: 'hmac-sha256',
			header: 'x-hub-signature-256',
			encoding: 'hex',
			secretName: 'prDeskGithubWebhookSecret',
		},
		existingHmacEncrypted: null,
	})
	expect(encrypted).toBeTruthy()
	expect(
		await decryptWebhookHmacSecret(
			env,
			encrypted!,
			userWebhookHmacSecretContext(ownerIdFromStored('user-1'), 'ep-1'),
		),
	).toBe('legacy-secret-store-value')
	expect(resolveSecret).toHaveBeenCalled()

	const generated = await storedCiphertext('kody-generated-at-migration')
	const replaced = await resolveHmacCiphertextForMint({
		env,
		request: sessionRequestContext('user-1', 'ada'),
		baseUrl: 'https://example.com',
		userId: ownerIdFromStored('user-1'),
		endpointId: 'ep-1',
		packageId: 'pkg-1',
		verification: stripeVerification,
		existingHmacEncrypted: generated,
	})
	expect(
		await decryptWebhookHmacSecret(
			env,
			replaced!,
			userWebhookHmacSecretContext(ownerIdFromStored('user-1'), 'ep-1'),
		),
	).toBe('legacy-secret-store-value')

	const { secretName: _secretName, ...withoutName } = stripeVerification
	expect(
		await resolveHmacCiphertextForMint({
			env,
			request: sessionRequestContext('user-1', 'ada'),
			baseUrl: 'https://example.com',
			userId: ownerIdFromStored('user-1'),
			endpointId: 'ep-1',
			packageId: 'pkg-1',
			verification: withoutName,
			existingHmacEncrypted: generated,
		}),
	).toBeUndefined()
})
