import { invalidateCommunityPublicCache } from '#app/data-cache.ts'
import { resolveUserStableId } from '#worker/user-id.ts'
import { CommunityActionError } from './errors.ts'
import {
	countActiveListingsForOwner,
	countPublicSavedPackagesForUser,
	getUserSocialRowByStableId,
	getUserSocialRowByUsername,
	listCommunityActivityForActors,
	listPublicProfilePackages as listPublicProfilePackagesFromDb,
	resolveCommunityDisplayName,
	updateUserProfileFields,
	type UserSocialRow,
} from './profile-repo.ts'
import {
	type CommunityActivityItem,
	type CommunityProfileRecord,
	type ProfileVisibility,
	type PublicProfilePackage,
} from './types.ts'

const maxDisplayNameLength = 50
const maxBioLength = 500

function resolveStableUserIdFromRow(row: UserSocialRow): string {
	return resolveUserStableId(row)
}

function toCommunityProfileRecord(input: {
	row: UserSocialRow
	stableUserId: string
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
	const stableUserId = resolveStableUserIdFromRow(input.row)
	const [publicPackageCount, listingCount] = await Promise.all([
		countPublicSavedPackagesForUser(input.env.APP_DB, stableUserId),
		countActiveListingsForOwner(input.env.APP_DB, stableUserId),
	])
	return toCommunityProfileRecord({
		row: input.row,
		stableUserId,
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
	if (patch.visibility !== undefined) {
		invalidateCommunityPublicCache()
	}
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
	includePrivate?: boolean
}): Promise<Array<PublicProfilePackage>> {
	return await listPublicProfilePackagesFromDb(input.env.APP_DB, {
		ownerStableUserId: input.ownerStableUserId,
		query: input.query,
		limit: input.limit,
		includePrivate: input.includePrivate,
	})
}
