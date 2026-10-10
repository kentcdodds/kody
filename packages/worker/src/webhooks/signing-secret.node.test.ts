import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { DatabaseSync } from 'node:sqlite'
import { expect, test, vi } from 'vitest'
import {
	decryptWebhookHmacSecret,
	encryptWebhookHmacSecret,
	userWebhookHmacSecretContext,
} from '#mcp/secrets/crypto.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import {
	resolveHmacCiphertextForMint,
	resolveWebhookHmacSigningSecret,
	shouldMintPackageOwnedWebhookHmac,
} from './signing-secret.ts'
import { type WebhookEndpointRecord } from './types.ts'

vi.mock('#mcp/secrets/service.ts', () => ({
	resolveSecret: vi.fn(async () => ({
		found: true,
		value: 'legacy-secret-store-value',
		allowedHosts: [],
		scope: 'user',
	})),
}))

const { resolveSecret } = await import('#mcp/secrets/service.ts')

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

test('resolveWebhookHmacSigningSecret prefers package-owned ciphertext', async () => {
	const env = {
		APP_DB: {} as D1Database,
		SECRET_STORE_KEY: 'test-secret-store-key-32-chars-minimum',
	} as Env
	const plaintext = 'package-owned-hmac-value'
	const encrypted = await encryptWebhookHmacSecret(
		env,
		plaintext,
		userWebhookHmacSecretContext(ownerIdFromStored('user-1'), 'ep-1'),
	)

	const value = await resolveWebhookHmacSigningSecret({
		env,
		userId: ownerIdFromStored('user-1'),
		endpoint: endpoint({ hmacSecretEncrypted: encrypted }),
		verification: {
			type: 'hmac-sha256',
			header: 'x-hub-signature-256',
			encoding: 'hex',
			secretName: 'ignoredWhenPackageOwned',
		},
	})
	expect(value).toBe(plaintext)
	expect(resolveSecret).not.toHaveBeenCalled()
})

test('apply resolve refuses live secretName lookup without package-owned HMAC', async () => {
	const env = {
		APP_DB: {} as D1Database,
		SECRET_STORE_KEY: 'test-secret-store-key-32-chars-minimum',
	} as Env
	await expect(
		resolveWebhookHmacSigningSecret({
			env,
			userId: ownerIdFromStored('user-1'),
			endpoint: endpoint(),
			verification: {
				type: 'hmac-sha256',
				header: 'x-hub-signature-256',
				encoding: 'hex',
				secretName: 'prDeskGithubWebhookSecret',
			},
		}),
	).rejects.toThrow(/package-owned signing secret/)
	expect(resolveSecret).not.toHaveBeenCalled()
})

test('inbound resolve may fall back to verification.secretName', async () => {
	const env = {
		APP_DB: {} as D1Database,
		SECRET_STORE_KEY: 'test-secret-store-key-32-chars-minimum',
	} as Env
	const value = await resolveWebhookHmacSigningSecret({
		env,
		userId: ownerIdFromStored('user-1'),
		endpoint: endpoint(),
		verification: {
			type: 'hmac-sha256',
			header: 'x-hub-signature-256',
			encoding: 'hex',
			secretName: 'sentryWebhookSecret',
		},
		allowLegacySecretNameFallback: true,
	})
	expect(value).toBe('legacy-secret-store-value')
	expect(resolveSecret).toHaveBeenCalled()
})

test('resolveHmacCiphertextForMint copies legacy secretName onto the endpoint', async () => {
	const sqlite = new DatabaseSync(':memory:')
	const db = createD1FromSqlite(sqlite)
	const env = {
		APP_DB: db,
		SECRET_STORE_KEY: 'test-secret-store-key-32-chars-minimum',
	} as Env
	vi.mocked(resolveSecret).mockClear()
	const encrypted = await resolveHmacCiphertextForMint({
		env,
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
})
