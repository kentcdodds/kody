import { DatabaseSync } from 'node:sqlite'
import { expect, test } from 'vitest'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import {
	deleteArtifactsPushSubscriptionBySourceId,
	getArtifactsPushSubscriptionBySourceId,
	upsertArtifactsPushSubscription,
} from './artifacts-push-subscription-store.ts'

function createDb() {
	const sqlite = new DatabaseSync(':memory:')
	sqlite.exec(`
		CREATE TABLE entity_source_artifacts_push_subscriptions (
			source_id TEXT PRIMARY KEY NOT NULL,
			user_id TEXT NOT NULL,
			repo_id TEXT NOT NULL,
			subscription_id TEXT NOT NULL,
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL
		);
		CREATE UNIQUE INDEX idx_entity_source_artifacts_push_subscriptions_repo_id
			ON entity_source_artifacts_push_subscriptions(repo_id);
	`)
	return createD1FromSqlite(sqlite)
}

test('artifacts push subscription store upserts, reads, and deletes by source', async () => {
	const db = createDb()
	await upsertArtifactsPushSubscription(db, {
		source_id: 'source-1',
		user_id: 'user-1',
		repo_id: 'repo-1',
		subscription_id: 'sub-1',
		created_at: '2026-05-01T00:00:00.000Z',
		updated_at: '2026-05-01T00:00:00.000Z',
	})
	await expect(
		getArtifactsPushSubscriptionBySourceId(db, 'source-1'),
	).resolves.toMatchObject({
		subscription_id: 'sub-1',
		repo_id: 'repo-1',
	})

	await upsertArtifactsPushSubscription(db, {
		source_id: 'source-1',
		user_id: 'user-1',
		repo_id: 'repo-1',
		subscription_id: 'sub-2',
		created_at: '2026-05-01T00:00:00.000Z',
		updated_at: '2026-05-02T00:00:00.000Z',
	})
	await expect(
		getArtifactsPushSubscriptionBySourceId(db, 'source-1'),
	).resolves.toMatchObject({
		subscription_id: 'sub-2',
	})

	await expect(
		deleteArtifactsPushSubscriptionBySourceId(db, {
			sourceId: 'source-1',
			userId: 'user-1',
		}),
	).resolves.toBe(true)
	await expect(
		getArtifactsPushSubscriptionBySourceId(db, 'source-1'),
	).resolves.toBeNull()
})

test('artifacts push subscription store returns null when the side table is absent', async () => {
	const sqlite = new DatabaseSync(':memory:')
	const db = createD1FromSqlite(sqlite)
	await expect(
		getArtifactsPushSubscriptionBySourceId(db, 'source-1'),
	).resolves.toBeNull()
	await expect(
		deleteArtifactsPushSubscriptionBySourceId(db, {
			sourceId: 'source-1',
			userId: 'user-1',
		}),
	).resolves.toBe(false)
})
