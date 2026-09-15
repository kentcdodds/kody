import {
	readAuthenticatedAppUser,
	type ReadAuthenticatedAppUserOptions,
} from '#app/authenticated-user.ts'
import {
	toPublicCommunityActivityItem,
	toPublicCommunityProfile,
	toPublicProfilePackageItem,
} from '#app/community-public.ts'
import { type ProfileLoaderData } from '#universal/loader-data.ts'
import { readProfilePackageFiltersFromUrl } from '#universal/profile-search.ts'
import { getUsernameFormatValidationError } from '#worker/identity/username.ts'
import {
	getCommunityProfileByUsername,
	getProfileActivity,
	listPublicProfilePackages,
} from '#worker/community/profile-service.ts'

const defaultProfileActivityLimit = 20
const maxProfilePackageLimit = 100

function readOptionalProfilePackageLimit(raw: string | null) {
	if (raw == null || raw === '') return undefined
	const parsed = Number.parseInt(raw, 10)
	if (!Number.isFinite(parsed) || parsed < 1) return undefined
	return Math.min(parsed, maxProfilePackageLimit)
}

const requestProfileDataStore = new WeakMap<
	Request,
	Map<string, Promise<ProfileLoaderData | null>>
>()

export function loadProfileData(
	env: Env,
	request: Request,
	username: string,
	options?: ReadAuthenticatedAppUserOptions,
): Promise<ProfileLoaderData | null> {
	let byUsername = requestProfileDataStore.get(request)
	if (!byUsername) {
		byUsername = new Map()
		requestProfileDataStore.set(request, byUsername)
	}
	const cacheKey = `${username}:${new URL(request.url).search}`
	let pending = byUsername.get(cacheKey)
	if (!pending) {
		pending = loadProfileDataUncached(env, request, username, options)
		byUsername.set(cacheKey, pending)
	}
	return pending
}

async function loadProfileDataUncached(
	env: Env,
	request: Request,
	username: string,
	options?: ReadAuthenticatedAppUserOptions,
): Promise<ProfileLoaderData | null> {
	if (getUsernameFormatValidationError(username)) {
		return null
	}

	const user = await readAuthenticatedAppUser(request, env, options)
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
	const filters = readProfilePackageFiltersFromUrl(url, {
		allowOwnerFilters: isSelf,
	})
	const packageLimit = readOptionalProfilePackageLimit(
		url.searchParams.get('limit'),
	)
	const serverQuery =
		packageLimit == null ? undefined : filters.query || undefined

	const [packages, activity] = await Promise.all([
		listPublicProfilePackages({
			env,
			ownerStableUserId: profile.userId,
			...(serverQuery ? { query: serverQuery } : {}),
			...(packageLimit == null ? {} : { limit: packageLimit }),
			includePrivate: isSelf,
		}),
		getProfileActivity({
			env,
			actorUserId: profile.userId,
			limit: defaultProfileActivityLimit,
			isSelf,
		}),
	])

	return {
		ok: true,
		profile: toPublicCommunityProfile(profile),
		packages: packages.map((pkg) =>
			toPublicProfilePackageItem(pkg, {
				includeOwnerVisibility: isSelf,
				username: profile.username,
			}),
		),
		activity: activity.map(toPublicCommunityActivityItem),
		query: filters.query || null,
		isSelf,
		loggedIn: Boolean(user),
	}
}
