import { parseUserAvatarCacheKey } from '#worker/community/avatar.ts'
import { parseListingOwnerUsername } from '#universal/community-links.ts'

export function buildUserAvatarUrl(input: {
	username: string
	avatarKey: string | null
}): string | null {
	if (!input.avatarKey) return null
	const cacheKey = parseUserAvatarCacheKey(input.avatarKey)
	if (!cacheKey) return null
	return `/profiles/${input.username}/avatar/${cacheKey}`
}

export function getOwnerUsernameFromListingName(name: string) {
	return parseListingOwnerUsername(name) ?? 'unknown'
}
