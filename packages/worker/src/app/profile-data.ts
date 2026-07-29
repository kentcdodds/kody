import { readPositiveInt } from '#worker/query-params.ts'
import { readAuthenticatedAppUser } from '#app/authenticated-user.ts'
import {
	toPublicCommunityActivityItem,
	toPublicCommunityProfile,
	toPublicProfilePackageItem,
} from '#app/community-public.ts'
import { type ProfileLoaderData } from '#app/loader-data.ts'
import { getUsernameFormatValidationError } from '#worker/identity/username.ts'
import { getUserFollow } from '#worker/community/social-repo.ts'
import {
	getCommunityProfileByUsername,
	getProfileActivity,
	listPublicProfilePackages,
} from '#worker/community/social-service.ts'

const defaultProfilePackageLimit = 50
const defaultProfileActivityLimit = 20

const requestProfileDataStore = new WeakMap<
	Request,
	Map<string, Promise<ProfileLoaderData | null>>
>()

export function loadProfileData(
	env: Env,
	request: Request,
	username: string,
): Promise<ProfileLoaderData | null> {
	let byUsername = requestProfileDataStore.get(request)
	if (!byUsername) {
		byUsername = new Map()
		requestProfileDataStore.set(request, byUsername)
	}
	const cacheKey = `${username}:${new URL(request.url).search}`
	let pending = byUsername.get(cacheKey)
	if (!pending) {
		pending = loadProfileDataUncached(env, request, username)
		byUsername.set(cacheKey, pending)
	}
	return pending
}

async function loadProfileDataUncached(
	env: Env,
	request: Request,
	username: string,
): Promise<ProfileLoaderData | null> {
	if (getUsernameFormatValidationError(username)) {
		return null
	}

	const user = await readAuthenticatedAppUser(request, env)
	const profile = await getCommunityProfileByUsername({
		env,
		username,
		includePrivate: true,
	})
	if (!profile) return null

	const viewerStableId = user?.mcpUser.userId ?? null
	const isSelf = viewerStableId != null && profile.userId === viewerStableId
	if (profile.visibility === 'private' && !isSelf) {
		return null
	}

	const url = new URL(request.url)
	const query = url.searchParams.get('q')?.trim() ?? ''
	const packageLimit = readPositiveInt(
		url.searchParams.get('limit'),
		defaultProfilePackageLimit,
		100,
	)

	const [packages, activity, isFollowing] = await Promise.all([
		listPublicProfilePackages({
			env,
			ownerStableUserId: profile.userId,
			query: query || undefined,
			limit: packageLimit,
		}),
		getProfileActivity({
			env,
			actorUserId: profile.userId,
			limit: defaultProfileActivityLimit,
			isSelf,
		}),
		viewerStableId && !isSelf
			? getUserFollow(env.APP_DB, {
					followerUserId: viewerStableId,
					followeeUserId: profile.userId,
				})
			: Promise.resolve(false),
	])

	return {
		ok: true,
		profile: toPublicCommunityProfile(profile),
		packages: packages.map(toPublicProfilePackageItem),
		activity: activity.map(toPublicCommunityActivityItem),
		query: query || null,
		isSelf,
		loggedIn: Boolean(user),
		isFollowing,
	}
}
