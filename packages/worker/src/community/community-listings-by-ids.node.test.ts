import { DatabaseSync } from 'node:sqlite'
import { expect, test } from 'vitest'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { ensureCommunityFlowSchema } from './community-flow-test-schema.ts'
import {
	getCommunityListingById,
	insertCommunityBan,
	insertCommunityFork,
	insertCommunityListing,
	upsertCommunityRating,
} from './repo.ts'
import {
	getCommunityListingWithAggregates,
	getCommunityListingsByIds,
} from './service.ts'
import { type CommunityListingStatus } from './types.ts'

async function createListingsDb() {
	const sqlite = new DatabaseSync(':memory:')
	await ensureCommunityFlowSchema(createD1FromSqlite(sqlite))
	const queries: Array<string> = []
	const db = createD1FromSqlite(sqlite, { queries })
	return { db, queries }
}

async function insertListing(
	db: D1Database,
	input: {
		id: string
		status?: CommunityListingStatus
		ownerUserId?: string
		kodyId?: string
	},
) {
	const kodyId = input.kodyId ?? input.id
	await insertCommunityListing(db, {
		id: input.id,
		owner_user_id: input.ownerUserId ?? 'owner-1',
		package_id: `pkg-${input.id}`,
		source_id: `src-${input.id}`,
		kody_id: kodyId,
		name: `@owner/${kodyId}`,
		description: `${kodyId} helpers`,
		tags_json: '[]',
		category: 'other',
		search_text: null,
		readme_content: null,
		license: 'MIT',
		pinned_commit: 'commit-1',
		status: input.status ?? 'active',
	})
}

test('getCommunityListingsByIds returns public listings in input order with batched aggregates', async () => {
	const { db, queries } = await createListingsDb()

	queries.length = 0
	expect(
		await getCommunityListingsByIds(db, [], { includeDelisted: false }),
	).toEqual([])
	expect(queries).toEqual([])

	await insertListing(db, { id: 'listing-a', kodyId: 'alpha' })
	await insertListing(db, { id: 'listing-b', kodyId: 'beta' })
	await insertListing(db, { id: 'listing-c', kodyId: 'gamma' })
	await insertListing(db, {
		id: 'listing-delisted',
		kodyId: 'retired',
		status: 'delisted',
	})
	await insertListing(db, {
		id: 'listing-banned-owner',
		kodyId: 'banned-pkg',
		ownerUserId: 'owner-banned',
	})
	await insertCommunityBan(db, {
		user_id: 'owner-banned',
		banned_by_user_id: 'admin-1',
		reason: 'spam',
	})
	await upsertCommunityRating(db, {
		id: 'rating-b',
		listing_id: 'listing-b',
		user_id: 'rater-1',
		stars: 4,
		adaptation_effort: 2,
		note: null,
	})
	await insertCommunityFork(db, {
		id: 'fork-b-1',
		listing_id: 'listing-b',
		forker_user_id: 'forker-1',
		origin_commit: 'commit-1',
		forked_package_id: 'pkg-fork-b-1',
		forked_source_id: 'src-fork-b-1',
		target_kody_id: 'beta',
		listing_name: '@owner/beta',
		listing_kody_id: 'beta',
	})
	await insertCommunityFork(db, {
		id: 'fork-b-2',
		listing_id: 'listing-b',
		forker_user_id: 'forker-2',
		origin_commit: 'commit-1',
		forked_package_id: 'pkg-fork-b-2',
		forked_source_id: 'src-fork-b-2',
		target_kody_id: 'beta',
		listing_name: '@owner/beta',
		listing_kody_id: 'beta',
	})

	expect(
		await getCommunityListingById(db, {
			listingId: 'listing-delisted',
			includeDelisted: false,
		}),
	).toBeNull()
	expect(
		await getCommunityListingById(db, {
			listingId: 'missing',
			includeDelisted: false,
		}),
	).toBeNull()
	expect(
		await getCommunityListingById(db, {
			listingId: 'listing-banned-owner',
			includeDelisted: false,
		}),
	).toEqual(
		expect.objectContaining({
			id: 'listing-banned-owner',
			status: 'active',
		}),
	)

	queries.length = 0
	const publicRows = await getCommunityListingsByIds(
		db,
		[
			'listing-c',
			'missing',
			'listing-a',
			'listing-delisted',
			'listing-b',
			'listing-banned-owner',
		],
		{ includeDelisted: false },
	)
	expect(publicRows.map((listing) => listing.id)).toEqual([
		'listing-c',
		'listing-a',
		'listing-b',
		'listing-banned-owner',
	])
	expect(publicRows.find((listing) => listing.id === 'listing-b')).toEqual(
		expect.objectContaining({
			id: 'listing-b',
			averageStars: 4,
			ratingCount: 1,
			averageAdaptationEffort: 2,
			forkCount: 2,
		}),
	)
	expect(queries).toHaveLength(3)
	expect(queries.filter((query) => query.includes(' IN ('))).toHaveLength(3)

	const withDelisted = await getCommunityListingsByIds(
		db,
		['listing-delisted', 'listing-a', 'missing'],
		{ includeDelisted: true },
	)
	expect(withDelisted.map((listing) => listing.id)).toEqual([
		'listing-delisted',
		'listing-a',
	])
	expect(
		await getCommunityListingById(db, {
			listingId: 'listing-delisted',
			includeDelisted: true,
		}),
	).toEqual(
		expect.objectContaining({ id: 'listing-delisted', status: 'delisted' }),
	)

	const single = await getCommunityListingWithAggregates({
		env: { APP_DB: db } as Env,
		listingId: 'listing-b',
		includeDelisted: false,
	})
	expect(publicRows.find((listing) => listing.id === 'listing-b')).toEqual(
		single,
	)
})
