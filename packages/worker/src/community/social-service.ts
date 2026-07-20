import { invalidateCommunityPublicCache } from '#app/data-cache.ts'
import { resolveUserStableId } from '#worker/user-id.ts'
import { CommunityActionError } from './errors.ts'
import { getCommunityBan, getCommunityListingById } from './repo.ts'
import { attachListingAggregatesBatch } from './service.ts'
import {
	countActiveListingsForOwner,
	countCommunityStarsByListingIds,
	countPublicSavedPackagesForUser,
	countUserFollowers,
	countUserFollowing,
	deleteCommunityStar,
	deleteUserFollow,
	getUserSocialRowByStableId,
	getUserSocialRowByUsername,
	insertCommunityStar,
	insertUserFollow,
	listCommunityActivityForActors,
	listCommunityListingsByIds,
	listCommunityStargazers,
	listFolloweeUserIds,
	listPublicProfilePackages as listPublicProfilePackagesFromDb,
	listStarredListingIdsByUser,
	resolveCommunityDisplayName,
	updateUserProfileFields,
	type UserSocialRow,
} from './social-repo.ts'
import {
	type CommunityActivityItem,
	type CommunityListingWithAggregates,
	type CommunityProfileRecord,
	type CommunityStargazer,
	type ProfileVisibility,
	type PublicProfilePackage,
} from './types.ts'

// Keep in sync with maxFolloweeIds in social-repo.ts.
const maxFollowingCount = 2000
const maxDisplayNameLength = 50
const maxBioLength = 500

async function resolveStableUserIdFromRow(row: UserSocialRow): Promise<string> {
	return await resolveUserStableId({
		email: row.email,
		stable_user_id: row.stable_user_id,
	})
}

function toCommunityProfileRecord(input: {
	row: UserSocialRow
	stableUserId: string
	followerCount: number
	followingCount: number
	publicPackageCount: number
	listingCount: number
}): CommunityProfileRecord {
	return {
		userId: input.stableUserId,
		username: input.row.username,
		displayName: resolveCommunityDisplayName({
			displayName: input.row.display_name,
			username: input.row.username,
		}),
		bio: input.row.bio,
		avatarKey: input.row.avatar_key,
		visibility: input.row.profile_visibility,
		joinedAt: input.row.created_at,
		followerCount: input.followerCount,
		followingCount: input.followingCount,
		publicPackageCount: input.publicPackageCount,
		listingCount: input.listingCount,
	}
}

async function loadCommunityProfileFromRow(input: {
	env: Env
	row: UserSocialRow
	includePrivate: boolean
}): Promise<CommunityProfileRecord | null> {
	if (input.row.profile_visibility === 'private' && !input.includePrivate) {
		return null
	}
	const stableUserId = await resolveStableUserIdFromRow(input.row)
	const [followerCount, followingCount, publicPackageCount, listingCount] =
		await Promise.all([
			countUserFollowers(input.env.APP_DB, stableUserId),
			countUserFollowing(input.env.APP_DB, stableUserId),
			countPublicSavedPackagesForUser(input.env.APP_DB, stableUserId),
			countActiveListingsForOwner(input.env.APP_DB, stableUserId),
		])
	return toCommunityProfileRecord({
		row: input.row,
		stableUserId,
		followerCount,
		followingCount,
		publicPackageCount,
		listingCount,
	})
}

export async function getCommunityProfileByUsername(input: {
	env: Env
	username: string
	includePrivate?: boolean
}): Promise<CommunityProfileRecord | null> {
	const row = await getUserSocialRowByUsername(input.env.APP_DB, input.username)
	if (!row) return null
	return await loadCommunityProfileFromRow({
		env: input.env,
		row,
		includePrivate: input.includePrivate ?? false,
	})
}

export async function getCommunityProfileByStableId(input: {
	env: Env
	stableUserId: string
	includePrivate?: boolean
}): Promise<CommunityProfileRecord | null> {
	const row = await getUserSocialRowByStableId(
		input.env.APP_DB,
		input.stableUserId,
	)
	if (!row) return null
	return await loadCommunityProfileFromRow({
		env: input.env,
		row,
		includePrivate: input.includePrivate ?? false,
	})
}

export async function updateCommunityProfile(input: {
	env: Env
	numericUserId: number
	displayName?: string
	bio?: string
	visibility?: ProfileVisibility
}): Promise<void> {
	const patch: {
		displayName?: string | null
		bio?: string | null
		visibility?: ProfileVisibility
	} = {}

	if (input.displayName !== undefined) {
		const trimmed = input.displayName.trim()
		if (trimmed.length > maxDisplayNameLength) {
			throw new CommunityActionError(
				`Display name must be at most ${maxDisplayNameLength} characters.`,
			)
		}
		patch.displayName = trimmed.length === 0 ? null : trimmed
	}
	if (input.bio !== undefined) {
		const trimmed = input.bio.trim()
		if (trimmed.length > maxBioLength) {
			throw new CommunityActionError(
				`Bio must be at most ${maxBioLength} characters.`,
			)
		}
		patch.bio = trimmed.length === 0 ? null : trimmed
	}
	if (input.visibility !== undefined) {
		if (input.visibility !== 'public' && input.visibility !== 'private') {
			throw new CommunityActionError('Profile visibility is invalid.')
		}
		patch.visibility = input.visibility
	}

	if (
		patch.displayName === undefined &&
		patch.bio === undefined &&
		patch.visibility === undefined
	) {
		return
	}

	await updateUserProfileFields(input.env.APP_DB, {
		numericUserId: input.numericUserId,
		...patch,
	})
}

async function assertNotCommunityBanned(db: D1Database, userId: string) {
	const ban = await getCommunityBan(db, userId)
	if (ban) {
		throw new CommunityActionError('banned from community participation')
	}
}

export async function followCommunityUser(input: {
	env: Env
	followerUserId: string
	followeeUsername: string
}): Promise<void> {
	await assertNotCommunityBanned(input.env.APP_DB, input.followerUserId)

	const followee = await getUserSocialRowByUsername(
		input.env.APP_DB,
		input.followeeUsername,
	)
	if (!followee || followee.profile_visibility === 'private') {
		throw new CommunityActionError('This profile is not available.')
	}

	const followeeUserId = await resolveStableUserIdFromRow(followee)
	if (followeeUserId === input.followerUserId) {
		throw new CommunityActionError('You cannot follow yourself.')
	}

	const followingCount = await countUserFollowing(
		input.env.APP_DB,
		input.followerUserId,
	)
	if (followingCount >= maxFollowingCount) {
		throw new CommunityActionError(
			`You can follow at most ${maxFollowingCount} people.`,
		)
	}

	await insertUserFollow(input.env.APP_DB, {
		followerUserId: input.followerUserId,
		followeeUserId,
	})
}

export async function unfollowCommunityUser(input: {
	env: Env
	followerUserId: string
	followeeUsername: string
}): Promise<void> {
	const followee = await getUserSocialRowByUsername(
		input.env.APP_DB,
		input.followeeUsername,
	)
	// Unknown usernames are a silent no-op (same as unfollowing someone you
	// do not follow) so unfollow cannot be used as a username existence oracle.
	if (!followee) return
	const followeeUserId = await resolveStableUserIdFromRow(followee)
	await deleteUserFollow(input.env.APP_DB, {
		followerUserId: input.followerUserId,
		followeeUserId,
	})
}

export async function starCommunityListing(input: {
	env: Env
	userId: string
	listingId: string
}): Promise<void> {
	await assertNotCommunityBanned(input.env.APP_DB, input.userId)

	const listing = await getCommunityListingById(input.env.APP_DB, {
		listingId: input.listingId,
		includeDelisted: false,
	})
	if (!listing) {
		throw new CommunityActionError(
			`Community listing "${input.listingId}" was not found.`,
		)
	}

	await insertCommunityStar(input.env.APP_DB, {
		listingId: input.listingId,
		userId: input.userId,
	})
	invalidateCommunityPublicCache()
}

export async function unstarCommunityListing(input: {
	env: Env
	userId: string
	listingId: string
}): Promise<void> {
	await deleteCommunityStar(input.env.APP_DB, {
		listingId: input.listingId,
		userId: input.userId,
	})
	invalidateCommunityPublicCache()
}

export async function listStarredCommunityListings(input: {
	env: Env
	userId: string
	limit: number
}): Promise<Array<CommunityListingWithAggregates>> {
	const listingIds = await listStarredListingIdsByUser(input.env.APP_DB, {
		userId: input.userId,
		limit: input.limit,
	})
	const listings = await listCommunityListingsByIds(
		input.env.APP_DB,
		listingIds,
	)
	return await attachListingAggregatesBatch(input.env.APP_DB, listings)
}

export async function listCommunityStargazersForListing(input: {
	env: Env
	listingId: string
	limit: number
}): Promise<{ totalStars: number; stargazers: Array<CommunityStargazer> }> {
	const [starCounts, stargazers] = await Promise.all([
		countCommunityStarsByListingIds(input.env.APP_DB, [input.listingId]),
		listCommunityStargazers(input.env.APP_DB, {
			listingId: input.listingId,
			limit: input.limit,
		}),
	])
	return {
		totalStars: starCounts[input.listingId] ?? 0,
		stargazers,
	}
}

export async function getCommunityTimeline(input: {
	env: Env
	userId: string
	limit: number
}): Promise<Array<CommunityActivityItem>> {
	const followeeUserIds = await listFolloweeUserIds(
		input.env.APP_DB,
		input.userId,
	)
	if (followeeUserIds.length === 0) return []
	return await listCommunityActivityForActors(input.env.APP_DB, {
		actorUserIds: followeeUserIds,
		limit: input.limit,
		requirePublicActorProfile: true,
	})
}

export async function getProfileActivity(input: {
	env: Env
	actorUserId: string
	limit: number
	isSelf: boolean
}): Promise<Array<CommunityActivityItem>> {
	return await listCommunityActivityForActors(input.env.APP_DB, {
		actorUserIds: [input.actorUserId],
		limit: input.limit,
		requirePublicActorProfile: !input.isSelf,
	})
}

export async function listPublicProfilePackages(input: {
	env: Env
	ownerStableUserId: string
	query?: string
	limit: number
}): Promise<Array<PublicProfilePackage>> {
	return await listPublicProfilePackagesFromDb(input.env.APP_DB, {
		ownerStableUserId: input.ownerStableUserId,
		query: input.query,
		limit: input.limit,
	})
}
