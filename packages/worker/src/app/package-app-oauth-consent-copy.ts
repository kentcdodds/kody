import {
	scopesIncludeEmail,
	type PackageAppOauthScope,
} from '#app/package-app-oauth-scopes.ts'

/**
 * Plain-language claims for the package-app OAuth consent page.
 * Keep these readable; raw scope strings stay in the collapsed Details.
 */
export function packageAppOauthClaimLabels(
	scopes: ReadonlyArray<PackageAppOauthScope | string>,
) {
	const claims = [
		'See your name, username, and avatar',
		'See your access level for this app',
	]
	if (scopesIncludeEmail(scopes)) {
		claims.push('See your email address')
	}
	return claims
}

export function packageAppOauthAppDomain(redirectUri: string) {
	try {
		return new URL(redirectUri).hostname
	} catch {
		return null
	}
}
