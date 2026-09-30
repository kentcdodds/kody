import { DatabaseSync } from 'node:sqlite'
import { expect, test, vi } from 'vitest'
import {
	decryptWebhookHmacSecret,
	encryptWebhookHmacSecret,
	userWebhookHmacSecretContext,
} from '#mcp/secrets/crypto.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import {
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
		userId: 'user-1',
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
	const sqlite = new DatabaseSync(':memory:')
	sqlite.exec(`
		CREATE TABLE webhook_endpoints (
			id TEXT PRIMARY KEY,
			user_id TEXT NOT NULL,
			package_id TEXT NOT NULL,
			webhook_name TEXT NOT NULL,
			url_secret_hash TEXT NOT NULL,
			url_secret_encrypted TEXT,
			hmac_secret_encrypted TEXT,
			enabled INTEGER NOT NULL DEFAULT 1,
			created_at TEXT NOT NULL,
			rotated_at TEXT NOT NULL
		);
	`)
	const db = createD1FromSqlite(sqlite)
	const env = {
		APP_DB: db,
		SECRET_STORE_KEY: 'test-secret-store-key-32-chars-minimum',
	} as Env
	const plaintext = 'package-owned-hmac-value'
	const encrypted = await encryptWebhookHmacSecret(
		env,
		plaintext,
		userWebhookHmacSecretContext('user-1', 'ep-1'),
	)
	await db
		.prepare(
			`INSERT INTO webhook_endpoints (
				id, user_id, package_id, webhook_name, url_secret_hash,
				hmac_secret_encrypted, enabled, created_at, rotated_at
			) VALUES ('ep-1', 'user-1', 'pkg-1', 'github', 'hash', ?, 1, 't', 't')`,
		)
		.bind(encrypted)
		.run()

	const value = await resolveWebhookHmacSigningSecret({
		env,
		userId: 'user-1',
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
	expect(
		await decryptWebhookHmacSecret(
			env,
			encrypted,
			userWebhookHmacSecretContext('user-1', 'ep-1'),
		),
	).toBe(plaintext)
})

test('resolveWebhookHmacSigningSecret migrates legacy secretName onto the endpoint', async () => {
	const sqlite = new DatabaseSync(':memory:')
	sqlite.exec(`
		CREATE TABLE webhook_endpoints (
			id TEXT PRIMARY KEY,
			user_id TEXT NOT NULL,
			package_id TEXT NOT NULL,
			webhook_name TEXT NOT NULL,
			url_secret_hash TEXT NOT NULL,
			url_secret_encrypted TEXT,
			hmac_secret_encrypted TEXT,
			enabled INTEGER NOT NULL DEFAULT 1,
			created_at TEXT NOT NULL,
			rotated_at TEXT NOT NULL
		);
	`)
	const db = createD1FromSqlite(sqlite)
	const env = {
		APP_DB: db,
		SECRET_STORE_KEY: 'test-secret-store-key-32-chars-minimum',
	} as Env
	await db
		.prepare(
			`INSERT INTO webhook_endpoints (
				id, user_id, package_id, webhook_name, url_secret_hash,
				enabled, created_at, rotated_at
			) VALUES ('ep-1', 'user-1', 'pkg-1', 'github', 'hash', 1, 't', 't')`,
		)
		.run()

	const value = await resolveWebhookHmacSigningSecret({
		env,
		userId: 'user-1',
		endpoint: endpoint(),
		verification: {
			type: 'hmac-sha256',
			header: 'x-hub-signature-256',
			encoding: 'hex',
			secretName: 'prDeskGithubWebhookSecret',
		},
		migrateLegacySecretNameToEndpoint: true,
	})
	expect(value).toBe('legacy-secret-store-value')
	expect(resolveSecret).toHaveBeenCalled()
	const row = await db
		.prepare(
			`SELECT hmac_secret_encrypted FROM webhook_endpoints WHERE id = 'ep-1'`,
		)
		.first<{ hmac_secret_encrypted: string }>()
	expect(row?.hmac_secret_encrypted).toBeTruthy()
	expect(
		await decryptWebhookHmacSecret(
			env,
			row!.hmac_secret_encrypted,
			userWebhookHmacSecretContext('user-1', 'ep-1'),
		),
	).toBe('legacy-secret-store-value')
})
