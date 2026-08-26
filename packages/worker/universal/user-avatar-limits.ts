export const userAvatarMaxSourceBytes = 1_000_000
export const userAvatarMinDimension = 64
export const userAvatarMaxDimension = 4096
export const userAvatarMaxAspectRatio = 3
export const userAvatarOutputContentTypes = [
	'image/png',
	'image/jpeg',
	'image/webp',
] as const

export type UserAvatarOutputContentType =
	(typeof userAvatarOutputContentTypes)[number]

export function normalizeUserAvatarContentType(
	contentType: string,
): UserAvatarOutputContentType | null {
	const normalized = contentType.trim().toLowerCase()
	switch (normalized) {
		case 'image/png':
			return 'image/png'
		case 'image/jpeg':
		case 'image/jpg':
			return 'image/jpeg'
		case 'image/webp':
			return 'image/webp'
		default:
			return null
	}
}

export function isUserAvatarOutputContentType(
	contentType: string,
): contentType is UserAvatarOutputContentType {
	return normalizeUserAvatarContentType(contentType) !== null
}
