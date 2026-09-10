import { DatabaseSync } from 'node:sqlite'
import { expect, test } from 'vitest'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import {
	countCommunityForksByListingIds,
	deleteCommunityForksForPackage,
	insertCommunityFork,
} from './repo.ts'
import { cleanupOrphanedCommunityForks } from './service.ts'

function createOrphanForkDb() {
	const sqlite = new DatabaseSync(':memory:')
	sqlite.exec(`
		CREATE TABLE saved_packages (
			id TEXT PRIMARY KEY NOT NULL,
			user_id TEXT NOT NULL,
			name TEXT NOT NULL,
			kody_id TEXT NOT NULL,
			description TEXT NOT NULL DEFAULT '',
			source_id TEXT NOT NULL
		);
		CREATE TABLE entity_sources (
			id TEXT PRIMARY KEY NOT NULL,
			user_id TEXT NOT NULL,
			entity_kind TEXT NOT NULL,
			entity_id TEXT NOT NULL
		);
		CREATE TABLE community_listings (
			id TEXT PRIMARY KEY NOT NULL,
			owner_user_id TEXT NOT NULL,
			package_id TEXT NOT NULL,
			source_id TEXT NOT NULL,
			kody_id TEXT NOT NULL,
			name TEXT NOT NULL,
			description TEXT NOT NULL DEFAULT '',
			license TEXT NOT NULL DEFAULT 'MIT',
			pinned_commit TEXT NOT NULL,
			status TEXT NOT NULL DEFAULT 'active'
		);
		CREATE TABLE community_forks (
			id TEXT PRIMARY KEY NOT NULL,
			listing_id TEXT NOT NULL,
			forker_user_id TEXT NOT NULL,
			origin_commit TEXT NOT NULL,
			forked_package_id TEXT NOT NULL,
			forked_source_id TEXT NOT NULL,
			target_kody_id TEXT NOT NULL,
			listing_name TEXT,
			listing_kody_id TEXT,
			adopted_at TEXT,
			adoption_note TEXT,
			actor TEXT,
			created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
		);
	`)
	return { sqlite, db: createD1FromSqlite(sqlite) }
}

async function seedListingAndForks(db: D1Database) {
	await db
		.prepare(
			`INSERT INTO community_listings (
				id, owner_user_id, package_id, source_id, kody_id, name, pinned_commit
			) VALUES ('listing-plaid', 'owner-1', 'origin-package', 'origin-source',
				'plaid', '@kody/plaid', 'commit-origin')`,
		)
		.run()
	await db
		.prepare(
			`INSERT INTO entity_sources (id, user_id, entity_kind, entity_id)
			VALUES ('source-inert', 'user-kent', 'package', 'package-inert'),
				('source-live', 'user-kent', 'package', 'package-live')`,
		)
		.run()
	await db
		.prepare(
			`INSERT INTO saved_packages (id, user_id, name, kody_id, source_id)
			VALUES ('package-live', 'user-kent', '@kentcdodds/plaid', 'plaid',
				'source-live')`,
		)
		.run()
	await insertCommunityFork(db, {
		id: 'fork-inert',
		listing_id: 'listing-plaid',
		forker_user_id: 'user-kent',
		origin_commit: 'commit-origin',
		forked_package_id: 'package-inert',
		forked_source_id: 'source-inert',
		target_kody_id: 'plaid-inert',
		listing_name: '@kody/plaid',
		listing_kody_id: 'plaid',
	})
	await insertCommunityFork(db, {
		id: 'fork-live',
		listing_id: 'listing-plaid',
		forker_user_id: 'user-kent',
		origin_commit: 'commit-origin',
		forked_package_id: 'package-live',
		forked_source_id: 'source-live',
		target_kody_id: 'plaid',
		listing_name: '@kody/plaid',
		listing_kody_id: 'plaid',
	})
	await insertCommunityFork(db, {
		id: 'fork-orphan',
		listing_id: 'listing-plaid',
		forker_user_id: 'user-kent',
		origin_commit: 'commit-origin',
		forked_package_id: 'package-missing',
		forked_source_id: 'source-missing',
		target_kody_id: 'plaid-fork-test-cleanup',
		listing_name: '@kody/plaid',
		listing_kody_id: 'plaid',
	})
}

test('orphan fork cleanup and package delete drop leftover community_forks without touching healthy forks', async () => {
	const { db } = createOrphanForkDb()
	await seedListingAndForks(db)
	const env = { APP_DB: db } as Env

	expect(await countCommunityForksByListingIds(db, ['listing-plaid'])).toEqual({
		'listing-plaid': 3,
	})

	const emptyFilter = await cleanupOrphanedCommunityForks({
		env,
		apply: true,
		forkIds: [],
	})
	expect(emptyFilter).toEqual({
		applied: true,
		deletedCount: 0,
		orphans: [],
	})
	expect(await countCommunityForksByListingIds(db, ['listing-plaid'])).toEqual({
		'listing-plaid': 3,
	})

	const preview = await cleanupOrphanedCommunityForks({
		env,
		apply: false,
	})
	expect(preview).toMatchObject({
		applied: false,
		deletedCount: 0,
		orphans: [
			expect.objectContaining({
				forkId: 'fork-orphan',
				forkedPackageId: 'package-missing',
				forkedSourceId: 'source-missing',
				targetKodyId: 'plaid-fork-test-cleanup',
			}),
		],
	})
	expect(await countCommunityForksByListingIds(db, ['listing-plaid'])).toEqual({
		'listing-plaid': 3,
	})

	const skippedHealthy = await cleanupOrphanedCommunityForks({
		env,
		apply: true,
		forkIds: ['fork-inert', 'fork-live'],
	})
	expect(skippedHealthy).toEqual({
		applied: true,
		deletedCount: 0,
		orphans: [],
	})
	expect(await countCommunityForksByListingIds(db, ['listing-plaid'])).toEqual({
		'listing-plaid': 3,
	})

	const applied = await cleanupOrphanedCommunityForks({
		env,
		apply: true,
		forkIds: ['fork-orphan'],
	})
	expect(applied).toMatchObject({
		applied: true,
		deletedCount: 1,
		orphans: [
			expect.objectContaining({
				forkId: 'fork-orphan',
			}),
		],
	})
	expect(await countCommunityForksByListingIds(db, ['listing-plaid'])).toEqual({
		'listing-plaid': 2,
	})

	expect(
		await deleteCommunityForksForPackage(db, {
			userId: 'user-kent',
			packageId: 'package-live',
			sourceId: 'source-live',
		}),
	).toBe(1)
	expect(await countCommunityForksByListingIds(db, ['listing-plaid'])).toEqual({
		'listing-plaid': 1,
	})

	const remaining = await db
		.prepare(`SELECT id, target_kody_id FROM community_forks`)
		.all<{ id: string; target_kody_id: string }>()
	expect(remaining.results).toEqual([
		{ id: 'fork-inert', target_kody_id: 'plaid-inert' },
	])
})
