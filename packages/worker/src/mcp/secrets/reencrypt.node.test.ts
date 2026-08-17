import { DatabaseSync } from 'node:sqlite'
import { expect, test } from 'vitest'
import { applyAllMigrations } from '#worker/test-support/apply-all-migrations.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import {
	decryptPlatformOauthClientSecret,
	decryptSecretValue,
	encryptPlatformOauthClientSecret,
	encryptSecretValue,
	platformOauthAppContext,
	userSecretContext,
} from './crypto.ts'
import { reencryptLegacySecretCiphertexts } from './reencrypt.ts'

const storeKey = 'reencrypt-test-secret-store-key-32-chars!!'

function toBase64Url(bytes: Uint8Array) {
	return btoa(String.fromCharCode(...bytes))
		.replaceAll('+', '-')
		.replaceAll('/', '_')
		.replace(/=+$/, '')
}

async function encryptLegacyPayload(input: {
	purpose: string
	plaintext: string
}) {
	const digest = await crypto.subtle.digest(
		'SHA-256',
		new TextEncoder().encode(`${input.purpose}:${storeKey}`),
	)
	const key = await crypto.subtle.importKey('raw', digest, 'AES-GCM', false, [
		'encrypt',
	])
	const iv = crypto.getRandomValues(new Uint8Array(12))
	const ciphertext = new Uint8Array(
		await crypto.subtle.encrypt(
			{ name: 'AES-GCM', iv },
			key,
			new TextEncoder().encode(input.plaintext),
		),
	)
	return `${toBase64Url(iv)}.${toBase64Url(ciphertext)}`
}

function createTestEnv(db: D1Database) {
	return {
		APP_DB: db,
		SECRET_STORE_KEY: storeKey,
	}
}

function createTestDb() {
	const sqlite = new DatabaseSync(':memory:')
	applyAllMigrations(sqlite, new URL('../../../migrations/', import.meta.url))
	return { sqlite, db: createD1FromSqlite(sqlite) }
}

async function insertSecretBucket(
	sqlite: DatabaseSync,
	input: { id: string; userId: string },
) {
	sqlite
		.prepare(
			`INSERT INTO secret_buckets (
				id, user_id, scope, binding_key, created_at, updated_at
			) VALUES (?, ?, 'user', 'global', '2026-08-01', '2026-08-01')`,
		)
		.run(input.id, input.userId)
}

async function insertSecretEntry(
	sqlite: DatabaseSync,
	input: { bucketId: string; name: string; encryptedValue: string },
) {
	sqlite
		.prepare(
			`INSERT INTO secret_entries (
				bucket_id, name, description, encrypted_value,
				allowed_hosts, allowed_capabilities, allowed_packages,
				created_at, updated_at
			) VALUES (?, ?, '', ?, '[]', '[]', '[]', '2026-08-01', '2026-08-01')`,
		)
		.run(input.bucketId, input.name, input.encryptedValue)
}

async function insertRemoteConnector(
	sqlite: DatabaseSync,
	input: {
		id: string
		userId: string
		instanceId: string
		encryptedSharedSecret: string | null
	},
) {
	sqlite
		.prepare(
			`INSERT INTO remote_connector_settings (
				id, user_id, instance_id, enabled, attached,
				encrypted_shared_secret, created_at, updated_at
			) VALUES (?, ?, ?, 1, 1, ?, '2026-07-06', '2026-07-06')`,
		)
		.run(input.id, input.userId, input.instanceId, input.encryptedSharedSecret)
}

async function insertPlatformApp(
	sqlite: DatabaseSync,
	input: { slug: string; encryptedSecret: string | null },
) {
	sqlite
		.prepare(
			`INSERT INTO platform_oauth_apps (
				slug, provider, client_id, client_secret_encrypted,
				token_url, authorize_url, flow, required_hosts_json
			) VALUES (
				?, 'google', 'client-id', ?,
				'https://example.com/token', 'https://example.com/auth',
				'confidential', '[]'
			)`,
		)
		.run(input.slug, input.encryptedSecret)
}

function readSecretPayload(
	sqlite: DatabaseSync,
	bucketId: string,
	name: string,
) {
	return sqlite
		.prepare(
			`SELECT encrypted_value, updated_at
			FROM secret_entries
			WHERE bucket_id = ? AND name = ?`,
		)
		.get(bucketId, name) as { encrypted_value: string; updated_at: string }
}

test('legacy secret re-encryption upgrades 2-part payloads, leaves v2 and corrupt rows, and honors dry-run, maxRows, and concurrent rotations', async () => {
	const { sqlite, db } = createTestDb()
	const env = createTestEnv(db)
	const userA = userSecretContext('user-a')
	const userB = userSecretContext('user-b')

	const userALegacy = await encryptLegacyPayload({
		purpose: 'mcp-secret-store',
		plaintext: 'user-a-legacy-secret',
	})
	const userBLegacy = await encryptLegacyPayload({
		purpose: 'mcp-secret-store',
		plaintext: 'user-b-legacy-secret',
	})
	const extraLegacy = await encryptLegacyPayload({
		purpose: 'mcp-secret-store',
		plaintext: 'user-a-extra-legacy',
	})
	const connectorLegacy = await encryptLegacyPayload({
		purpose: 'mcp-secret-store',
		plaintext: 'connector-shared-secret',
	})
	const platformLegacy = await encryptLegacyPayload({
		purpose: 'platform-oauth-client-secret',
		plaintext: 'platform-client-secret',
	})
	const userAVersioned = await encryptSecretValue(
		env,
		'already-v2-secret',
		userA,
	)
	const platformVersioned = await encryptPlatformOauthClientSecret(
		env,
		'already-v2-platform',
		platformOauthAppContext('keep-v2'),
	)

	insertSecretBucket(sqlite, { id: 'bucket-a', userId: 'user-a' })
	insertSecretBucket(sqlite, { id: 'bucket-b', userId: 'user-b' })
	insertSecretEntry(sqlite, {
		bucketId: 'bucket-a',
		name: 'a-legacy',
		encryptedValue: userALegacy,
	})
	insertSecretEntry(sqlite, {
		bucketId: 'bucket-a',
		name: 'b-legacy',
		encryptedValue: extraLegacy,
	})
	insertSecretEntry(sqlite, {
		bucketId: 'bucket-a',
		name: 'z-corrupt',
		encryptedValue: 'not-a-valid-ciphertext',
	})
	insertSecretEntry(sqlite, {
		bucketId: 'bucket-a',
		name: 'keep-v2',
		encryptedValue: userAVersioned,
	})
	insertSecretEntry(sqlite, {
		bucketId: 'bucket-b',
		name: 'legacy-ok',
		encryptedValue: userBLegacy,
	})
	insertRemoteConnector(sqlite, {
		id: 'connector-legacy',
		userId: 'user-a',
		instanceId: 'home',
		encryptedSharedSecret: connectorLegacy,
	})
	insertRemoteConnector(sqlite, {
		id: 'connector-empty',
		userId: 'user-b',
		instanceId: 'office',
		encryptedSharedSecret: null,
	})
	insertPlatformApp(sqlite, {
		slug: 'legacy-app',
		encryptedSecret: platformLegacy,
	})
	insertPlatformApp(sqlite, {
		slug: 'keep-v2',
		encryptedSecret: platformVersioned,
	})
	insertPlatformApp(sqlite, {
		slug: 'corrupt-app',
		encryptedSecret: 'totally-broken',
	})

	const dryRun = await reencryptLegacySecretCiphertexts({
		env,
		dryRun: true,
	})
	expect(dryRun.dryRun).toBe(true)
	expect(dryRun.secretEntries).toEqual({
		scanned: 4,
		rewritten: 3,
		skippedConcurrent: 0,
		decryptFailed: 1,
		remaining: 4,
	})
	expect(dryRun.remoteConnectorSettings).toEqual({
		scanned: 1,
		rewritten: 1,
		skippedConcurrent: 0,
		decryptFailed: 0,
		remaining: 1,
	})
	expect(dryRun.platformOauthApps).toEqual({
		scanned: 2,
		rewritten: 1,
		skippedConcurrent: 0,
		decryptFailed: 1,
		remaining: 2,
	})
	expect(dryRun.decryptFailures).toEqual([
		{ table: 'secret_entries', key: 'bucket-a/z-corrupt' },
		{ table: 'platform_oauth_apps', key: 'corrupt-app' },
	])
	expect(
		readSecretPayload(sqlite, 'bucket-a', 'a-legacy').encrypted_value,
	).toBe(userALegacy)
	expect(JSON.stringify(dryRun)).not.toContain(userALegacy)
	expect(JSON.stringify(dryRun)).not.toContain('user-a-legacy-secret')

	const bounded = await reencryptLegacySecretCiphertexts({
		env,
		maxRows: 2,
		pageSize: 1,
	})
	expect(bounded.dryRun).toBe(false)
	expect(bounded.secretEntries.rewritten).toBe(2)
	expect(bounded.secretEntries.remaining).toBe(2)
	expect(bounded.remoteConnectorSettings.scanned).toBe(0)
	expect(bounded.platformOauthApps.scanned).toBe(0)

	const finish = await reencryptLegacySecretCiphertexts({ env, pageSize: 1 })
	expect(finish.secretEntries).toEqual({
		scanned: 2,
		rewritten: 1,
		skippedConcurrent: 0,
		decryptFailed: 1,
		remaining: 1,
	})
	expect(finish.remoteConnectorSettings).toEqual({
		scanned: 1,
		rewritten: 1,
		skippedConcurrent: 0,
		decryptFailed: 0,
		remaining: 0,
	})
	expect(finish.platformOauthApps).toEqual({
		scanned: 2,
		rewritten: 1,
		skippedConcurrent: 0,
		decryptFailed: 1,
		remaining: 1,
	})

	const upgradedUserA = readSecretPayload(sqlite, 'bucket-a', 'a-legacy')
	expect(upgradedUserA.encrypted_value.startsWith('v2.')).toBe(true)
	expect(upgradedUserA.encrypted_value).not.toBe(userALegacy)
	expect(
		await decryptSecretValue(env, upgradedUserA.encrypted_value, userA),
	).toBe('user-a-legacy-secret')
	await expect(
		decryptSecretValue(env, upgradedUserA.encrypted_value, userB),
	).rejects.toThrow('Unable to decrypt secret value.')

	const keptV2 = readSecretPayload(sqlite, 'bucket-a', 'keep-v2')
	expect(keptV2.encrypted_value).toBe(userAVersioned)
	expect(keptV2.updated_at).toBe('2026-08-01')
	expect(
		readSecretPayload(sqlite, 'bucket-a', 'z-corrupt').encrypted_value,
	).toBe('not-a-valid-ciphertext')

	const connectorRow = sqlite
		.prepare(
			`SELECT encrypted_shared_secret FROM remote_connector_settings WHERE id = ?`,
		)
		.get('connector-legacy') as { encrypted_shared_secret: string }
	expect(connectorRow.encrypted_shared_secret.startsWith('v2.')).toBe(true)
	expect(
		await decryptSecretValue(env, connectorRow.encrypted_shared_secret, userA),
	).toBe('connector-shared-secret')

	const platformRow = sqlite
		.prepare(
			`SELECT client_secret_encrypted FROM platform_oauth_apps WHERE slug = ?`,
		)
		.get('legacy-app') as { client_secret_encrypted: string }
	expect(platformRow.client_secret_encrypted.startsWith('v2.')).toBe(true)
	expect(
		await decryptPlatformOauthClientSecret(
			env,
			platformRow.client_secret_encrypted,
			platformOauthAppContext('legacy-app'),
		),
	).toBe('platform-client-secret')
	await expect(
		decryptPlatformOauthClientSecret(
			env,
			platformRow.client_secret_encrypted,
			platformOauthAppContext('other-app'),
		),
	).rejects.toThrow('Unable to decrypt platform client secret.')

	const concurrentLegacy = await encryptLegacyPayload({
		purpose: 'mcp-secret-store',
		plaintext: 'concurrent-loses',
	})
	const concurrentWinner = await encryptSecretValue(
		env,
		'user-rotated-value',
		userA,
	)
	insertSecretEntry(sqlite, {
		bucketId: 'bucket-a',
		name: 'legacy-concurrent',
		encryptedValue: concurrentLegacy,
	})
	const concurrentDb: D1Database = {
		...db,
		prepare(query: string) {
			const statement = db.prepare(query)
			if (
				!query.includes('UPDATE secret_entries') ||
				!query.includes('encrypted_value')
			) {
				return statement
			}
			return {
				bind(...params: Array<unknown>) {
					const bound = statement.bind(...params)
					return {
						...bound,
						async run() {
							sqlite
								.prepare(
									`UPDATE secret_entries
									SET encrypted_value = ?
									WHERE bucket_id = ? AND name = ?`,
								)
								.run(concurrentWinner, params[2], params[3])
							return bound.run()
						},
					}
				},
			}
		},
	} as D1Database
	const concurrent = await reencryptLegacySecretCiphertexts({
		env: createTestEnv(concurrentDb),
	})
	expect(concurrent.secretEntries.skippedConcurrent).toBe(1)
	expect(concurrent.secretEntries.rewritten).toBe(0)
	expect(
		readSecretPayload(sqlite, 'bucket-a', 'legacy-concurrent').encrypted_value,
	).toBe(concurrentWinner)
	expect(
		await decryptSecretValue(
			env,
			readSecretPayload(sqlite, 'bucket-a', 'legacy-concurrent')
				.encrypted_value,
			userA,
		),
	).toBe('user-rotated-value')
})
