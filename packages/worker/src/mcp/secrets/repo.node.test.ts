import { maxD1BoundParameters } from '@kody-internal/shared/chunk.ts'
import { DatabaseSync } from 'node:sqlite'
import { expect, test } from 'vitest'
import { applyAllMigrations } from '#worker/test-support/apply-all-migrations.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { listPackageScopeSecretMetadata } from './repo.ts'

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
	const userId = 'user-with-many-packages'
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
