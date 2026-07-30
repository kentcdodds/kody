import { parseUserAvatarCacheKey } from '#worker/community/avatar.ts'

export function buildUserAvatarUrl(input: {
	username: string
	avatarKey: string | null
}): string | null {
	if (!input.avatarKey) return null
	const cacheKey = parseUserAvatarCacheKey(input.avatarKey)
	if (!cacheKey) return null
	return `/profiles/${input.username}/avatar/${cacheKey}`
}

const scopedPackageNamePattern = /^@([a-z0-9][a-z0-9._-]*)\//

export function getOwnerUsernameFromListingName(name: string) {
	const match = scopedPackageNamePattern.exec(name.trim())
	return match?.[1] ?? 'unknown'
}
