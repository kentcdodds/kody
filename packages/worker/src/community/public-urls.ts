import {
	parseUserAvatarCacheKey,
	splitUserAvatarCacheKey,
} from '#worker/community/avatar.ts'
import { parseListingOwnerUsername } from '#universal/community-links.ts'
import { routes } from '#universal/routes.ts'

export function buildUserAvatarUrl(input: {
	username: string
	avatarKey: string | null
}): string | null {
	if (!input.avatarKey) return null
	const cacheKey = parseUserAvatarCacheKey(input.avatarKey)
	if (!cacheKey) return null
	const parts = splitUserAvatarCacheKey(cacheKey)
	if (!parts) return null
	return routes.profileAvatar.href({
		username: input.username,
		hash: parts.hash,
		ext: parts.ext,
	})
}

export function getOwnerUsernameFromListingName(name: string) {
	return parseListingOwnerUsername(name) ?? 'unknown'
}
