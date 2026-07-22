import { env } from 'cloudflare:workers'
import { expect, test } from 'vitest'
import { createStableUserIdFromEmail } from '#worker/user-id.ts'
import { CommunityActionError } from './errors.ts'
import { ensureCommunityFlowSchema } from './community-flow-test-schema.ts'
import {
	followCommunityUser,
	getCommunityProfileByUsername,
	getCommunityTimeline,
	getProfileActivity,
	listPublicProfilePackages,
	starCommunityListing,
	unfollowCommunityUser,
	unstarCommunityListing,
	updateCommunityProfile,
} from './social-service.ts'
import {
	countCommunityStarsByListingIds,
	insertCommunityActivityEvent,
} from './social-repo.ts'

async function runSql(sql: string, ...values: Array<unknown>) {
	await env.APP_DB.prepare(sql)
		.bind(...values)
		.run()
}

async function insertUser(input: {
	email: string
	username: string
	visibility?: 'public' | 'private'
	displayName?: string | null
}): Promise<{
	numericId: number
	userId: string
	email: string
	username: string
}> {
	await ensureCommunityFlowSchema(env.APP_DB)
	const userId = await createStableUserIdFromEmail(input.email)
	await runSql(
		`INSERT INTO users (
			username, email, stable_user_id, display_name, profile_visibility, password_hash, plan
		) VALUES (?, ?, ?, ?, ?, ?, ?)`,
		input.username,
		input.email,
		userId,
		input.displayName ?? null,
		input.visibility ?? 'public',
		'test-password-hash',
		'max',
	)
	const row = await env.APP_DB.prepare(
		`SELECT id FROM users WHERE stable_user_id = ?`,
	)
		.bind(userId)
		.first<{ id: number }>()
	if (!row) throw new Error('Failed to insert test user')
	return {
		numericId: row.id,
		userId,
		email: input.email,
		username: input.username,
	}
}

async function insertListing(input: {
	id: string
	ownerUserId: string
	packageId: string
	name: string
	kodyId: string
}) {
	const now = new Date().toISOString()
	await runSql(
		`INSERT INTO community_listings (
			id, owner_user_id, package_id, source_id, kody_id, name, description,
			tags_json, license, pinned_commit, status, created_at, updated_at, published_at
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)`,
		input.id,
		input.ownerUserId,
		input.packageId,
		`source-${input.packageId}`,
		input.kodyId,
		input.name,
		`${input.kodyId} description`,
		JSON.stringify(['social']),
		'MIT',
		'commit-1',
		now,
		now,
		now,
	)
}

async function insertSavedPackage(input: {
	id: string
	userId: string
	name: string
	kodyId: string
	description?: string
	tags?: Array<string>
	searchText?: string
	isPrivate: boolean
	hidden?: boolean
	updatedAt?: string
}) {
	await runSql(
		`INSERT INTO saved_packages (
			id, user_id, name, kody_id, description, tags_json, search_text,
			source_id, has_app, hidden, is_private, created_at, updated_at
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?)`,
		input.id,
		input.userId,
		input.name,
		input.kodyId,
		input.description ?? `${input.kodyId} description`,
		JSON.stringify(input.tags ?? ['social']),
		input.searchText ?? `${input.kodyId} search`,
		`source-${input.id}`,
		input.hidden ? 1 : 0,
		input.isPrivate ? 1 : 0,
		input.updatedAt ?? '2026-07-01T00:00:00.000Z',
		input.updatedAt ?? '2026-07-01T00:00:00.000Z',
	)
}

test('follow and unfollow enforce private profiles and self-follow', async () => {
	const alice = await insertUser({
		email: `alice-follow-${crypto.randomUUID()}@example.com`,
		username: `alicef${crypto.randomUUID().slice(0, 8)}`,
	})
	const bob = await insertUser({
		email: `bob-follow-${crypto.randomUUID()}@example.com`,
		username: `bobf${crypto.randomUUID().slice(0, 8)}`,
	})
	const privateUser = await insertUser({
		email: `private-follow-${crypto.randomUUID()}@example.com`,
		username: `privf${crypto.randomUUID().slice(0, 8)}`,
		visibility: 'private',
	})

	await expect(
		followCommunityUser({
			env,
			followerUserId: alice.userId,
			followeeUsername: alice.username,
		}),
	).rejects.toBeInstanceOf(CommunityActionError)

	await expect(
		followCommunityUser({
			env,
			followerUserId: alice.userId,
			followeeUsername: privateUser.username,
		}),
	).rejects.toThrow('This profile is not available.')

	await followCommunityUser({
		env,
		followerUserId: alice.userId,
		followeeUsername: bob.username,
	})
	const bobProfile = await getCommunityProfileByUsername({
		env,
		username: bob.username,
	})
	expect(bobProfile?.followerCount).toBe(1)

	await unfollowCommunityUser({
		env,
		followerUserId: alice.userId,
		followeeUsername: bob.username,
	})
	const bobAfter = await getCommunityProfileByUsername({
		env,
		username: bob.username,
	})
	expect(bobAfter?.followerCount).toBe(0)

	// Not-following is a successful no-op.
	await unfollowCommunityUser({
		env,
		followerUserId: alice.userId,
		followeeUsername: bob.username,
	})

	// Unknown usernames are also a silent no-op (no existence oracle).
	await expect(
		unfollowCommunityUser({
			env,
			followerUserId: alice.userId,
			followeeUsername: `missing${crypto.randomUUID().slice(0, 8)}`,
		}),
	).resolves.toBeUndefined()
})

test('star and unstar update starCount aggregates', async () => {
	const owner = await insertUser({
		email: `owner-star-${crypto.randomUUID()}@example.com`,
		username: `owners${crypto.randomUUID().slice(0, 8)}`,
	})
	const stargazer = await insertUser({
		email: `stargazer-${crypto.randomUUID()}@example.com`,
		username: `stars${crypto.randomUUID().slice(0, 8)}`,
	})
	const listingId = `listing-star-${crypto.randomUUID()}`
	await insertListing({
		id: listingId,
		ownerUserId: owner.userId,
		packageId: `pkg-${listingId}`,
		name: `@${owner.username}/starred`,
		kodyId: 'starred',
	})

	await starCommunityListing({
		env,
		userId: stargazer.userId,
		listingId,
	})
	await starCommunityListing({
		env,
		userId: stargazer.userId,
		listingId,
	})
	expect(
		await countCommunityStarsByListingIds(env.APP_DB, [listingId]),
	).toEqual({ [listingId]: 1 })

	await unstarCommunityListing({
		env,
		userId: stargazer.userId,
		listingId,
	})
	expect(
		await countCommunityStarsByListingIds(env.APP_DB, [listingId]),
	).toEqual({ [listingId]: 0 })
})

test('timeline merges stored and derived events with fork privacy and private actors', async () => {
	const viewer = await insertUser({
		email: `viewer-${crypto.randomUUID()}@example.com`,
		username: `view${crypto.randomUUID().slice(0, 8)}`,
	})
	const actor = await insertUser({
		email: `actor-${crypto.randomUUID()}@example.com`,
		username: `actor${crypto.randomUUID().slice(0, 8)}`,
		displayName: 'Actor Display',
	})
	const privateActor = await insertUser({
		email: `private-actor-${crypto.randomUUID()}@example.com`,
		username: `pact${crypto.randomUUID().slice(0, 8)}`,
		visibility: 'private',
	})

	const listingId = `listing-tl-${crypto.randomUUID()}`
	const forkPackageId = `fork-pkg-${crypto.randomUUID()}`
	await insertListing({
		id: listingId,
		ownerUserId: actor.userId,
		packageId: `pkg-${listingId}`,
		name: `@${actor.username}/timeline`,
		kodyId: 'timeline',
	})
	await insertSavedPackage({
		id: forkPackageId,
		userId: actor.userId,
		name: `@${actor.username}/timeline-fork`,
		kodyId: 'timeline-fork',
		isPrivate: true,
	})
	await runSql(
		`INSERT INTO community_forks (
			id, listing_id, forker_user_id, origin_commit, forked_package_id,
			forked_source_id, target_kody_id, created_at
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		`fork-${crypto.randomUUID()}`,
		listingId,
		actor.userId,
		'commit-1',
		forkPackageId,
		`source-${forkPackageId}`,
		'timeline-fork',
		'2026-07-03T00:00:00.000Z',
	)
	await insertCommunityActivityEvent(env.APP_DB, {
		id: crypto.randomUUID(),
		actorUserId: actor.userId,
		eventType: 'listing_published',
		listingId,
		createdAt: '2026-07-01T00:00:00.000Z',
	})
	await starCommunityListing({
		env,
		userId: actor.userId,
		listingId,
	})
	await runSql(
		`UPDATE community_stars SET created_at = ? WHERE listing_id = ? AND user_id = ?`,
		'2026-07-02T00:00:00.000Z',
		listingId,
		actor.userId,
	)
	await insertCommunityActivityEvent(env.APP_DB, {
		id: crypto.randomUUID(),
		actorUserId: privateActor.userId,
		eventType: 'listing_published',
		listingId,
		createdAt: '2026-07-04T00:00:00.000Z',
	})

	await followCommunityUser({
		env,
		followerUserId: viewer.userId,
		followeeUsername: actor.username,
	})
	// Following private profiles is rejected; insert the follow row directly so
	// the timeline can prove private actors are still filtered out.
	await runSql(
		`INSERT INTO user_follows (follower_user_id, followee_user_id)
		VALUES (?, ?)`,
		viewer.userId,
		privateActor.userId,
	)

	const timelinePrivateFork = await getCommunityTimeline({
		env,
		userId: viewer.userId,
		limit: 20,
	})
	expect(timelinePrivateFork.map((item) => item.type)).toEqual([
		'listing_starred',
		'listing_published',
	])
	expect(
		timelinePrivateFork.every((item) => item.actorUserId === actor.userId),
	).toBe(true)
	expect(timelinePrivateFork[0]?.actorDisplayName).toBe('Actor Display')

	await runSql(
		`UPDATE saved_packages SET is_private = 0 WHERE id = ? AND user_id = ?`,
		forkPackageId,
		actor.userId,
	)
	const timelinePublicFork = await getCommunityTimeline({
		env,
		userId: viewer.userId,
		limit: 20,
	})
	expect(timelinePublicFork.map((item) => item.type)).toEqual([
		'listing_forked',
		'listing_starred',
		'listing_published',
	])

	const selfActivity = await getProfileActivity({
		env,
		actorUserId: privateActor.userId,
		limit: 10,
		isSelf: true,
	})
	expect(selfActivity.some((item) => item.type === 'listing_published')).toBe(
		true,
	)
	const publicActivity = await getProfileActivity({
		env,
		actorUserId: privateActor.userId,
		limit: 10,
		isSelf: false,
	})
	expect(publicActivity).toEqual([])
})

test('profile get hides private profiles unless includePrivate', async () => {
	const user = await insertUser({
		email: `profile-${crypto.randomUUID()}@example.com`,
		username: `prof${crypto.randomUUID().slice(0, 8)}`,
		visibility: 'private',
		displayName: 'Hidden Person',
	})

	expect(
		await getCommunityProfileByUsername({
			env,
			username: user.username,
		}),
	).toBeNull()

	const privateProfile = await getCommunityProfileByUsername({
		env,
		username: user.username,
		includePrivate: true,
	})
	expect(privateProfile).toMatchObject({
		userId: user.userId,
		username: user.username,
		displayName: 'Hidden Person',
		visibility: 'private',
	})
})

test('updateCommunityProfile validates display name and bio bounds', async () => {
	const user = await insertUser({
		email: `update-${crypto.randomUUID()}@example.com`,
		username: `upd${crypto.randomUUID().slice(0, 8)}`,
	})

	await expect(
		updateCommunityProfile({
			env,
			numericUserId: user.numericId,
			displayName: 'x'.repeat(51),
		}),
	).rejects.toThrow(/Display name must be at most 50/)

	await expect(
		updateCommunityProfile({
			env,
			numericUserId: user.numericId,
			bio: 'y'.repeat(501),
		}),
	).rejects.toThrow(/Bio must be at most 500/)

	await updateCommunityProfile({
		env,
		numericUserId: user.numericId,
		displayName: '  Nice Name  ',
		bio: '  Hello world  ',
		visibility: 'private',
	})
	const profile = await getCommunityProfileByUsername({
		env,
		username: user.username,
		includePrivate: true,
	})
	expect(profile).toMatchObject({
		displayName: 'Nice Name',
		bio: 'Hello world',
		visibility: 'private',
	})

	await updateCommunityProfile({
		env,
		numericUserId: user.numericId,
		displayName: '   ',
		bio: '',
		visibility: 'public',
	})
	const cleared = await getCommunityProfileByUsername({
		env,
		username: user.username,
	})
	expect(cleared?.displayName).toBe(user.username)
	expect(cleared?.bio).toBeNull()
	expect(cleared?.visibility).toBe('public')
})

test('listPublicProfilePackages filters private/hidden packages and supports query', async () => {
	const owner = await insertUser({
		email: `pkgs-${crypto.randomUUID()}@example.com`,
		username: `pkgs${crypto.randomUUID().slice(0, 8)}`,
	})
	await insertSavedPackage({
		id: `public-${crypto.randomUUID()}`,
		userId: owner.userId,
		name: `@${owner.username}/public-notes`,
		kodyId: 'public-notes',
		description: 'public diary helpers',
		tags: ['notes'],
		isPrivate: false,
		updatedAt: '2026-07-02T00:00:00.000Z',
	})
	await insertSavedPackage({
		id: `private-${crypto.randomUUID()}`,
		userId: owner.userId,
		name: `@${owner.username}/secret-notes`,
		kodyId: 'secret-notes',
		description: 'private diary helpers',
		tags: ['notes'],
		isPrivate: true,
		updatedAt: '2026-07-03T00:00:00.000Z',
	})
	await insertSavedPackage({
		id: `hidden-${crypto.randomUUID()}`,
		userId: owner.userId,
		name: `@${owner.username}/hidden-notes`,
		kodyId: 'hidden-notes',
		description: 'hidden diary helpers',
		tags: ['notes'],
		isPrivate: false,
		hidden: true,
		updatedAt: '2026-07-04T00:00:00.000Z',
	})
	await insertSavedPackage({
		id: `other-${crypto.randomUUID()}`,
		userId: owner.userId,
		name: `@${owner.username}/calendar`,
		kodyId: 'calendar',
		description: 'schedule helpers',
		tags: ['calendar'],
		searchText: 'unique-search-oracle-token',
		isPrivate: false,
		updatedAt: '2026-07-01T00:00:00.000Z',
	})

	const allPublic = await listPublicProfilePackages({
		env,
		ownerStableUserId: owner.userId,
		limit: 10,
	})
	expect(allPublic.map((pkg) => pkg.kodyId).sort()).toEqual([
		'calendar',
		'public-notes',
	])

	const profile = await getCommunityProfileByUsername({
		env,
		username: owner.username,
	})
	expect(profile?.publicPackageCount).toBe(2)

	const queried = await listPublicProfilePackages({
		env,
		ownerStableUserId: owner.userId,
		query: 'notes',
		limit: 10,
	})
	expect(queried.map((pkg) => pkg.kodyId)).toEqual(['public-notes'])

	// search_text is not publicly searchable (substring-probing oracle).
	const searchTextOnly = await listPublicProfilePackages({
		env,
		ownerStableUserId: owner.userId,
		query: 'unique-search-oracle-token',
		limit: 10,
	})
	expect(searchTextOnly).toEqual([])
})
