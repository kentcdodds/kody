import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { maxD1BoundParameters } from '@kody-internal/shared/chunk.ts'
import { readFileSync, readdirSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { expect, test } from 'vitest'
import { applyAllMigrations } from '#worker/test-support/apply-all-migrations.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import {
	getSecretEntry,
	getStoredCredentialEntry,
	listPackageScopeSecretMetadata,
	listSecretBucketsByScope,
} from './repo.ts'

const migrationsDirectory = new URL('../../../migrations/', import.meta.url)
const credentialKindsMigration = '0117-credential-kinds.sql'

function createSecretsDb(options?: { maxBindings?: number }) {
	const sqlite = new DatabaseSync(':memory:')
	applyAllMigrations(sqlite, new URL('../../../migrations/', import.meta.url))
	return {
		sqlite,
		db: createD1FromSqlite(sqlite, options),
	}
}

function insertPackageSecret(
	sqlite: DatabaseSync,
	input: {
		bucketId: string
		userId: string
		packageId: string
		name: string
	},
) {
	sqlite
		.prepare(
			`INSERT INTO secret_buckets (
				id, user_id, scope, binding_key, created_at, updated_at
			) VALUES (?, ?, 'package', ?, '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z')`,
		)
		.run(input.bucketId, input.userId, input.packageId)
	sqlite
		.prepare(
			`INSERT INTO secret_entries (
				bucket_id, name, description, encrypted_value,
				allowed_hosts, allowed_packages,
				created_at, updated_at
			) VALUES (?, ?, '', 'ciphertext', '[]', '[]', '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z')`,
		)
		.run(input.bucketId, input.name)
}

test('listPackageScopeSecretMetadata chunks package ids to stay within the D1 binding limit', async () => {
	const { sqlite, db } = createSecretsDb({ maxBindings: maxD1BoundParameters })
	const userId = ownerIdFromStored('user-with-many-packages')
	const packageIds = Array.from(
		{ length: maxD1BoundParameters + 1 },
		(_, index) => `package-${String(index).padStart(3, '0')}`,
	)
	insertPackageSecret(sqlite, {
		bucketId: 'bucket-first',
		userId,
		packageId: packageIds[0] ?? 'package-000',
		name: 'alpha-token',
	})
	insertPackageSecret(sqlite, {
		bucketId: 'bucket-last',
		userId,
		packageId: packageIds.at(-1) ?? 'package-100',
		name: 'zeta-token',
	})

	const rows = await listPackageScopeSecretMetadata({
		db,
		userId,
		packageIds,
		now: '2026-08-31T00:00:00.000Z',
	})

	expect(rows).toEqual([
		expect.objectContaining({
			name: 'alpha-token',
			binding_key: 'package-000',
			scope: 'package',
		}),
		expect.objectContaining({
			name: 'zeta-token',
			binding_key: 'package-100',
			scope: 'package',
		}),
	])
})

test('listSecretBucketsByScope returns caller-owned package buckets only', async () => {
	const { sqlite, db } = createSecretsDb()
	insertPackageSecret(sqlite, {
		bucketId: 'bucket-owned',
		userId: ownerIdFromStored('user-1'),
		packageId: 'package-owned',
		name: 'owned-token',
	})
	insertPackageSecret(sqlite, {
		bucketId: 'bucket-other',
		userId: ownerIdFromStored('user-2'),
		packageId: 'package-other',
		name: 'other-token',
	})

	const buckets = await listSecretBucketsByScope({
		db,
		userId: ownerIdFromStored('user-1'),
		scope: 'package',
		now: '2026-08-31T00:00:00.000Z',
	})

	expect(buckets).toEqual([
		expect.objectContaining({
			user_id: ownerIdFromStored('user-1'),
			scope: 'package',
			binding_key: 'package-owned',
		}),
	])
})

function applyMigrationsBeforeCredentialKinds() {
	const sqlite = new DatabaseSync(':memory:', {
		enableForeignKeyConstraints: false,
	})
	for (const name of readdirSync(migrationsDirectory)
		.filter(
			(fileName) =>
				fileName.endsWith('.sql') && fileName < credentialKindsMigration,
		)
		.sort()) {
		sqlite.exec(readFileSync(new URL(name, migrationsDirectory), 'utf8'))
	}
	sqlite.exec(`
		INSERT INTO secret_buckets (id, user_id, scope, binding_key)
		VALUES ('bucket-user', 'org-user', 'user', '');
		INSERT INTO secret_entries (id, bucket_id, name, encrypted_value)
		VALUES ('cred-openai', 'bucket-user', 'OPENAI_KEY', 'ct');
	`)
	return sqlite
}

test('secret reads treat a pre-0117 schema as kind secret so placeholders still resolve', async () => {
	const sqlite = applyMigrationsBeforeCredentialKinds()
	const db = createD1FromSqlite(sqlite)

	await expect(
		getSecretEntry({ db, bucketId: 'bucket-user', name: 'OPENAI_KEY' }),
	).resolves.toEqual(
		expect.objectContaining({
			id: 'cred-openai',
			name: 'OPENAI_KEY',
			kind: 'secret',
		}),
	)
	await expect(
		getStoredCredentialEntry({
			db,
			ownerId: 'org-user',
			credentialId: 'cred-openai',
			now: '2026-10-12T00:00:00.000Z',
		}),
	).resolves.toEqual(
		expect.objectContaining({
			id: 'cred-openai',
			name: 'OPENAI_KEY',
			kind: 'secret',
		}),
	)

	sqlite.exec(
		readFileSync(
			new URL(credentialKindsMigration, migrationsDirectory),
			'utf8',
		),
	)
	sqlite.exec(`UPDATE secret_entries SET kind = 'url' WHERE id = 'cred-openai'`)
	await expect(
		getSecretEntry({ db, bucketId: 'bucket-user', name: 'OPENAI_KEY' }),
	).resolves.toEqual(expect.objectContaining({ kind: 'url' }))
	await expect(
		getStoredCredentialEntry({
			db,
			ownerId: 'org-user',
			credentialId: 'cred-openai',
			now: '2026-10-12T00:00:00.000Z',
		}),
	).resolves.toEqual(expect.objectContaining({ kind: 'url' }))
})

test('stored credential reads keep the kind on a pre-0118 schema and report no exchange', async () => {
	const sqlite = applyMigrationsBeforeCredentialKinds()
	sqlite.exec(
		readFileSync(
			new URL(credentialKindsMigration, migrationsDirectory),
			'utf8',
		),
	)
	sqlite.exec(`UPDATE secret_entries SET kind = 'url' WHERE id = 'cred-openai'`)
	const db = createD1FromSqlite(sqlite)
	const read = () =>
		getStoredCredentialEntry({
			db,
			ownerId: 'org-user',
			credentialId: 'cred-openai',
			now: '2026-10-12T00:00:00.000Z',
		})

	await expect(read()).resolves.toEqual(
		expect.objectContaining({ kind: 'url', config_json: null }),
	)

	sqlite.exec(
		readFileSync(
			new URL('0118-credential-login-config.sql', migrationsDirectory),
			'utf8',
		),
	)
	sqlite.exec(
		`UPDATE secret_entries SET kind = 'login', config_json = '{}' WHERE id = 'cred-openai'`,
	)
	await expect(read()).resolves.toEqual(
		expect.objectContaining({ kind: 'login', config_json: '{}' }),
	)
})
