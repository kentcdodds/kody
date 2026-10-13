/**
 * Deleting a package's secrets removes the grants, pending grant invites, and
 * personal-credential org grants on every deleted package secret, in the same
 * batch. Grants on the owner's other credentials stay.
 */
import { DatabaseSync } from 'node:sqlite'
import { expect, test } from 'vitest'
import { deleteAllPackageScopedSecrets } from '#worker/package-config-cleanup.ts'
import { applyAllMigrations } from '#worker/test-support/apply-all-migrations.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'

const now = '2026-10-13T00:00:00.000Z'
const ownerId = 'owner-org'
const otherOrgId = 'other-org'

function setup() {
	const sqlite = new DatabaseSync(':memory:')
	applyAllMigrations(sqlite, new URL('../migrations/', import.meta.url))
	sqlite.exec('PRAGMA foreign_keys = ON')
	const db = createD1FromSqlite(sqlite)
	for (const id of [ownerId, otherOrgId]) {
		sqlite
			.prepare(
				`INSERT INTO orgs (id, slug, created_at, updated_at) VALUES (?, ?, ?, ?)`,
			)
			.run(id, id, now, now)
	}
	const buckets = {
		doomed: { id: 'bucket-doomed', scope: 'package', bindingKey: 'pkg-doomed' },
		otherPackage: {
			id: 'bucket-other-package',
			scope: 'package',
			bindingKey: 'pkg-kept',
		},
		user: { id: 'bucket-user', scope: 'user', bindingKey: '' },
	}
	for (const bucket of Object.values(buckets)) {
		sqlite
			.prepare(
				`INSERT INTO secret_buckets (id, user_id, scope, binding_key)
				VALUES (?, ?, ?, ?)`,
			)
			.run(bucket.id, ownerId, bucket.scope, bucket.bindingKey)
	}

	const insertSecret = (bucketId: string, name: string) => {
		sqlite
			.prepare(
				`INSERT INTO secret_entries (bucket_id, name, encrypted_value)
				VALUES (?, ?, 'x')`,
			)
			.run(bucketId, name)
		const id = String(
			(
				sqlite
					.prepare(
						`SELECT id FROM secret_entries WHERE bucket_id = ? AND name = ?`,
					)
					.get(bucketId, name) as { id: string }
			).id,
		)
		for (const subjectId of ['ann', 'bea']) {
			const grantId = `grant-${id}-${subjectId}`
			sqlite
				.prepare(
					`INSERT INTO grants (id, org_id, resource_type, resource_id,
						subject_type, subject_id, preset, created_by_user_id,
						created_at, updated_at)
					VALUES (?, ?, 'credential', ?, 'user', ?, 'use', 'bea', ?, ?)`,
				)
				.run(grantId, ownerId, id, subjectId, now, now)
			sqlite
				.prepare(
					`INSERT INTO grant_permissions (grant_id, permission)
					VALUES (?, 'secret.use')`,
				)
				.run(grantId)
		}
		sqlite
			.prepare(
				`INSERT INTO invites (id, org_id, kind, resource_type, resource_id,
					preset, invitee_username, token_hash, status, invited_by_user_id,
					expires_at, created_at)
				VALUES (?, ?, 'grant', 'credential', ?, 'use', 'cy', ?, 'pending',
					'bea', '2099-01-01T00:00:00.000Z', ?)`,
			)
			.run(`invite-${id}`, ownerId, id, id, now)
		sqlite
			.prepare(
				`INSERT INTO credential_org_grants (credential_id, user_id, org_id, created_at)
				VALUES (?, ?, ?, ?)`,
			)
			.run(id, ownerId, otherOrgId, now)
		return id
	}

	const snapshot = (credentialId: string) => ({
		liveGrants: sqlite
			.prepare(
				`SELECT subject_id FROM grants
				WHERE resource_type = 'credential' AND resource_id = ?
					AND deleted_at IS NULL ORDER BY subject_id`,
			)
			.all(credentialId)
			.map((row) => row['subject_id']),
		pendingInvites: sqlite
			.prepare(
				`SELECT id FROM invites
				WHERE resource_type = 'credential' AND resource_id = ?
					AND status = 'pending'`,
			)
			.all(credentialId)
			.map((row) => row['id']),
		orgGrants: sqlite
			.prepare(
				`SELECT org_id FROM credential_org_grants WHERE credential_id = ?`,
			)
			.all(credentialId)
			.map((row) => row['org_id']),
	})

	const accessEpoch = () =>
		Number(
			(
				sqlite
					.prepare(`SELECT access_epoch FROM orgs WHERE id = ?`)
					.get(ownerId) as { access_epoch: number }
			).access_epoch,
		)

	const secretCount = (bucketId: string) =>
		Number(
			(
				sqlite
					.prepare(
						`SELECT COUNT(*) AS n FROM secret_entries WHERE bucket_id = ?`,
					)
					.get(bucketId) as { n: number }
			).n,
		)

	return {
		env: { APP_DB: db },
		buckets,
		insertSecret,
		snapshot,
		accessEpoch,
		secretCount,
	}
}

test('deleting package secrets leaves no grants on any of them and keeps grants on other credentials', async () => {
	const { env, buckets, insertSecret, snapshot, accessEpoch, secretCount } =
		setup()
	const doomed = [
		insertSecret(buckets.doomed.id, 'apiKey'),
		insertSecret(buckets.doomed.id, 'webhookSecret'),
	]
	const kept = [
		insertSecret(buckets.otherPackage.id, 'apiKey'),
		insertSecret(buckets.user.id, 'apiKey'),
	]
	const keptBefore = kept.map(snapshot)
	const epochBefore = accessEpoch()

	await expect(
		deleteAllPackageScopedSecrets({
			env,
			userId: ownerId,
			packageId: buckets.doomed.bindingKey,
		}),
	).resolves.toBe(1)

	expect(secretCount(buckets.doomed.id)).toBe(0)
	for (const id of doomed) {
		expect(snapshot(id)).toEqual({
			liveGrants: [],
			pendingInvites: [],
			orgGrants: [],
		})
	}
	expect(kept.map(snapshot)).toEqual(keptBefore)
	expect(keptBefore).toEqual(
		kept.map((id) => ({
			liveGrants: ['ann', 'bea'],
			pendingInvites: [`invite-${id}`],
			orgGrants: [otherOrgId],
		})),
	)
	expect(accessEpoch()).toBe(epochBefore + 1)
})

test('deleting package secrets with no grants leaves the access epoch alone', async () => {
	const { env, buckets, accessEpoch } = setup()
	const epochBefore = accessEpoch()

	await deleteAllPackageScopedSecrets({
		env,
		userId: ownerId,
		packageId: buckets.doomed.bindingKey,
	})

	expect(accessEpoch()).toBe(epochBefore)
})
