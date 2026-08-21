const usablePasswordHashPrefix = 'pbkdf2_sha256$'

export function isUsablePasswordHash(passwordHash: string | null | undefined) {
	return passwordHash?.startsWith(usablePasswordHashPrefix) === true
}
