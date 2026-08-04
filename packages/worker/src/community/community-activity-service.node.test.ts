import { DatabaseSync } from 'node:sqlite'
import { expect, test } from 'vitest'
import {
	countCommunityForksByListingIds,
	insertCommunityFork,
	upsertCommunityRating,
} from './repo.ts'
import {
	getCommunityActivityForAdmin,
	listCommunityActivityForAdmin,
} from './service.ts'

type TestD1Statement = {
	bind(...params: Array<unknown>): TestD1Statement
	all<T>(): Promise<{ results: Array<T> }>
	first<T>(): Promise<T | null>
	run(): Promise<{ meta: { changes: number } }>
}

function createD1FromSqlite(sqlite: DatabaseSync) {
	function createStatement(
		query: string,
		params: Array<unknown> = [],
	): TestD1Statement {
		return {
			bind(...boundParams: Array<unknown>) {
				return createStatement(query, boundParams)
			},
			async all<T>() {
				return { results: sqlite.prepare(query).all(...params) as Array<T> }
			},
			async first<T>() {
				return (sqlite.prepare(query).get(...params) ?? null) as T | null
			},
			async run() {
				const result = sqlite.prepare(query).run(...params)
				return { meta: { changes: result.changes } }
			},
		}
	}
	return {
		prepare(query: string) {
			return createStatement(query)
		},
	} as unknown as D1Database
}

function createCommunityDb() {
	const sqlite = new DatabaseSync(':memory:')
	sqlite.exec(`CREATE TABLE users (
		id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
		username TEXT NOT NULL UNIQUE,
		email TEXT NOT NULL UNIQUE,
		password_hash TEXT NOT NULL,
		stable_user_id TEXT
	)`)
	// Mirrors the community_listings, community_ratings, and community_forks
	// schemas in packages/worker/migrations/0001-squashed-init.sql.
	sqlite.exec(`
CREATE TABLE community_listings (
	id TEXT PRIMARY KEY NOT NULL,
	owner_user_id TEXT NOT NULL,
	package_id TEXT NOT NULL,
	source_id TEXT NOT NULL,
	kody_id TEXT NOT NULL,
	name TEXT NOT NULL,
	description TEXT NOT NULL,
	tags_json TEXT NOT NULL DEFAULT '[]',
	search_text TEXT,
	readme_content TEXT,
	license TEXT NOT NULL,
	pinned_commit TEXT NOT NULL,
	status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'delisted')),
	created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
	updated_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
	published_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
, trusted_commit TEXT, trusted_by_user_id TEXT, trusted_at TEXT, featured_at TEXT);
CREATE TABLE community_ratings (
	id TEXT PRIMARY KEY NOT NULL,
	listing_id TEXT NOT NULL,
	user_id TEXT NOT NULL,
	stars INTEGER NOT NULL CHECK (stars BETWEEN 1 AND 5),
	adaptation_effort INTEGER NOT NULL CHECK (adaptation_effort BETWEEN 1 AND 5),
	note TEXT,
	created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
	updated_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
);
CREATE TABLE IF NOT EXISTS "community_forks" (
	id TEXT PRIMARY KEY NOT NULL,
	listing_id TEXT NOT NULL,
	forker_user_id TEXT NOT NULL,
	origin_commit TEXT NOT NULL,
	forked_package_id TEXT NOT NULL,
	forked_source_id TEXT NOT NULL,
	target_kody_id TEXT NOT NULL,
	listing_name TEXT,
	listing_kody_id TEXT,
	created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
, adopted_at TEXT, adoption_note TEXT, actor TEXT
CHECK (actor IS NULL OR actor IN ('human', 'agent')));
CREATE UNIQUE INDEX idx_community_listings_owner_package
ON community_listings(owner_user_id, package_id);
CREATE INDEX idx_community_listings_status
ON community_listings(status);
CREATE UNIQUE INDEX idx_community_ratings_listing_user
ON community_ratings(listing_id, user_id);
CREATE INDEX idx_community_forks_listing_id
	ON community_forks(listing_id);
CREATE INDEX idx_community_forks_forker_listing
	ON community_forks(forker_user_id, listing_id);
CREATE INDEX idx_community_forks_forked_package_id
ON community_forks(forked_package_id);
`)
	return { sqlite, db: createD1FromSqlite(sqlite) }
}

test('admin community activity reads forks and latest ratings newest-first with pagination and filters', async () => {
	const { sqlite, db } = createCommunityDb()
	sqlite
		.prepare(
			`INSERT INTO users (
				username, email, password_hash, stable_user_id
			) VALUES (?, ?, 'hash', ?), (?, ?, 'hash', ?)`,
		)
		.run(
			'forker',
			'forker@example.com',
			'user-forker',
			'rater',
			'rater@example.com',
			'user-rater',
		)
	for (const listing of [
		{ id: 'listing-1', kodyId: 'alpha', name: '@owner/alpha' },
		{ id: 'listing-2', kodyId: 'beta', name: '@owner/beta' },
	]) {
		sqlite
			.prepare(
				`INSERT INTO community_listings (
					id, owner_user_id, package_id, source_id, kody_id, name,
					description, tags_json, license, pinned_commit, status,
					created_at, updated_at, published_at
				) VALUES (?, 'owner', ?, ?, ?, ?, 'description', '[]', 'MIT',
					'commit-1', 'active', '2026-07-20T00:00:00.000Z',
					'2026-07-20T00:00:00.000Z', '2026-07-20T00:00:00.000Z')`,
			)
			.run(
				listing.id,
				`package-${listing.id}`,
				`source-${listing.id}`,
				listing.kodyId,
				listing.name,
			)
	}

	for (const fork of [
		{
			id: 'fork-1',
			listingId: 'listing-1',
			createdAt: '2026-07-20T00:01:00.000Z',
		},
		{
			id: 'fork-2',
			listingId: 'listing-1',
			createdAt: '2026-07-20T00:02:00.000Z',
		},
		{
			id: 'fork-3',
			listingId: 'listing-2',
			createdAt: '2026-07-20T00:03:00.000Z',
		},
	]) {
		await insertCommunityFork(db, {
			id: fork.id,
			listing_id: fork.listingId,
			forker_user_id: 'user-forker',
			origin_commit: 'commit-1',
			forked_package_id: `package-${fork.id}`,
			forked_source_id: `source-${fork.id}`,
			target_kody_id: `target-${fork.id}`,
			listing_name:
				fork.listingId === 'listing-1' ? '@owner/alpha' : '@owner/beta',
			listing_kody_id: fork.listingId === 'listing-1' ? 'alpha' : 'beta',
			created_at: fork.createdAt,
		})
	}

	const firstRating = await upsertCommunityRating(db, {
		id: 'rating-original',
		listing_id: 'listing-1',
		user_id: 'user-rater',
		stars: 4,
		adaptation_effort: 3,
		note: 'not exposed',
		created_at: '2026-07-20T00:04:00.000Z',
		updated_at: '2026-07-20T00:04:00.000Z',
	})
	const updatedRating = await upsertCommunityRating(db, {
		id: 'rating-replacement',
		listing_id: 'listing-1',
		user_id: 'user-rater',
		stars: 5,
		adaptation_effort: 1,
		note: 'still not exposed',
		created_at: '2026-07-20T00:05:00.000Z',
		updated_at: '2026-07-20T00:05:00.000Z',
	})
	expect(firstRating.id).toBe('rating-original')
	expect(updatedRating).toMatchObject({
		id: 'rating-original',
		stars: 5,
		adaptationEffort: 1,
		updatedAt: '2026-07-20T00:05:00.000Z',
	})

	const firstPage = await listCommunityActivityForAdmin({ db, pageSize: 2 })
	expect(firstPage).toMatchObject({ total: 4, page: 1, pageSize: 2 })
	expect(firstPage.items).toEqual([
		{
			id: 'rating-original',
			kind: 'rating',
			listingId: 'listing-1',
			listingName: '@owner/alpha',
			listingKodyId: 'alpha',
			actingUsername: 'rater',
			occurredAt: '2026-07-20T00:05:00.000Z',
			stars: 5,
			adaptationEffort: 1,
		},
		{
			id: 'fork-3',
			kind: 'fork',
			listingId: 'listing-2',
			listingName: '@owner/beta',
			listingKodyId: 'beta',
			actingUsername: 'forker',
			occurredAt: '2026-07-20T00:03:00.000Z',
		},
	])

	const clamped = await listCommunityActivityForAdmin({
		db,
		page: 99,
		pageSize: 2,
	})
	expect(clamped.page).toBe(2)
	expect(clamped.items.map((item) => item.id)).toEqual(['fork-2', 'fork-1'])

	const filtered = await listCommunityActivityForAdmin({
		db,
		kind: 'rating',
		listingId: 'listing-1',
	})
	expect(filtered.total).toBe(1)
	expect(filtered.items).toEqual([firstPage.items[0]])
	expect(
		await getCommunityActivityForAdmin({
			db,
			kind: 'rating',
			activityId: 'rating-original',
		}),
	).toEqual(firstPage.items[0])

	sqlite.prepare(`DELETE FROM community_listings WHERE id = 'listing-2'`).run()
	const deletedListingActivity = await listCommunityActivityForAdmin({
		db,
		kind: 'fork',
		listingId: 'listing-2',
	})
	expect(deletedListingActivity.items).toEqual([
		{
			id: 'fork-3',
			kind: 'fork',
			listingId: 'listing-2',
			listingName: '@owner/beta',
			listingKodyId: 'beta',
			actingUsername: 'forker',
			occurredAt: '2026-07-20T00:03:00.000Z',
		},
	])

	expect(
		await countCommunityForksByListingIds(db, [
			'listing-1',
			'listing-2',
			'listing-without-forks',
		]),
	).toEqual({
		'listing-1': 2,
		'listing-2': 1,
		'listing-without-forks': 0,
	})
})
