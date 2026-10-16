/** Default claims always included; `email` is opt-in and needs consent. */
export const packageAppOauthDefaultScopes = ['profile'] as const
export const packageAppOauthOptionalScopes = ['email'] as const

export type PackageAppOauthScope =
	| (typeof packageAppOauthDefaultScopes)[number]
	| (typeof packageAppOauthOptionalScopes)[number]

const optionalSet = new Set<string>(packageAppOauthOptionalScopes)

export function parsePackageAppOauthScopes(raw: string | null | undefined): {
	scopes: Array<PackageAppOauthScope>
	error: string | null
} {
	const requested = (raw ?? '')
		.split(/[\s+,]+/)
		.map((part) => part.trim().toLowerCase())
		.filter((part) => part.length > 0)
	const scopes = new Set<PackageAppOauthScope>(packageAppOauthDefaultScopes)
	for (const part of requested) {
		if (part === 'profile' || part === 'openid') continue
		if (optionalSet.has(part)) {
			scopes.add(part as PackageAppOauthScope)
			continue
		}
		return {
			scopes: [...packageAppOauthDefaultScopes],
			error: `Unsupported scope: ${part}`,
		}
	}
	return { scopes: [...scopes], error: null }
}

export function scopesIncludeEmail(scopes: ReadonlyArray<string>) {
	return scopes.includes('email')
}

export function serializePackageAppOauthScopes(
	scopes: ReadonlyArray<PackageAppOauthScope>,
) {
	return [...new Set(scopes)].sort().join(' ')
}
