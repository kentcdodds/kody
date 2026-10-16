import { getPackageAppBaseUrl } from '#worker/app-base-url.ts'
import {
	lookupVerifiedAppCustomHostnameForPackage,
	lookupVerifiedOrgCustomHostnameForPackage,
} from '#worker/package-app-custom-hostnames/lookup.ts'
import { isPackageAppCustomDomainsEnabled } from '#worker/package-app-custom-hostnames/feature-flag.ts'
import { packageAppOauthPaths } from '#universal/package-app-oauth-paths.ts'
import { buildPackageAppSubdomainUrl } from '@kody-internal/shared/public-urls.ts'
import { type PackageAppOauthClientId } from '#app/package-app-oauth-client-id.ts'

/**
 * Redirect URIs for package-app OAuth are not registered. They must be the
 * platform callback on an origin that already serves this package:
 * the owner's `*.kody.run` (or local) subdomain, a verified app custom
 * hostname, or a verified org custom hostname (private apps).
 */

function normalizeCallbackUrl(raw: string): URL | null {
	let url: URL
	try {
		url = new URL(raw)
	} catch {
		return null
	}
	if (url.username || url.password) return null
	if (url.hash) return null
	if (url.search) return null
	if (url.pathname !== packageAppOauthPaths.callback) return null
	if (url.protocol !== 'https:' && url.protocol !== 'http:') return null
	// http only for local package-app hosts (*.localhost).
	if (url.protocol === 'http:') {
		const host = url.hostname.toLowerCase()
		if (host !== 'localhost' && !host.endsWith('.localhost')) return null
	}
	return url
}

export async function listAllowedPackageAppOauthRedirectUris(input: {
	env: Env
	client: PackageAppOauthClientId
}): Promise<Array<string>> {
	const allowed: Array<string> = []
	const packageAppOrigin = getPackageAppBaseUrl({ env: input.env })
	if (packageAppOrigin) {
		try {
			const subdomain = new URL(
				buildPackageAppSubdomainUrl({
					packageAppOrigin,
					username: input.client.username,
					kodyId: input.client.kodyId,
				}),
			)
			allowed.push(`${subdomain.origin}${packageAppOauthPaths.callback}`)
		} catch {
			// Ignore unparsable package-app origin.
		}
	}

	if (!(await isPackageAppCustomDomainsEnabled(input.env.APP_DB))) {
		return allowed
	}

	const appMapping = await lookupVerifiedAppCustomHostnameForPackage({
		db: input.env.APP_DB,
		username: input.client.username,
		kodyId: input.client.kodyId,
	})
	if (appMapping) {
		allowed.push(
			`https://${appMapping.hostname}${packageAppOauthPaths.callback}`,
		)
	}

	const orgMapping = await lookupVerifiedOrgCustomHostnameForPackage({
		db: input.env.APP_DB,
		username: input.client.username,
		kodyId: input.client.kodyId,
	})
	if (orgMapping) {
		allowed.push(
			`https://${orgMapping.hostname}${packageAppOauthPaths.callback}`,
		)
	}

	return allowed
}

export async function isAllowedPackageAppOauthRedirectUri(input: {
	env: Env
	client: PackageAppOauthClientId
	redirectUri: string
}): Promise<boolean> {
	const normalized = normalizeCallbackUrl(input.redirectUri)
	if (!normalized) return false
	const allowed = await listAllowedPackageAppOauthRedirectUris({
		env: input.env,
		client: input.client,
	})
	const candidate = normalized.toString().replace(/\/$/, '')
	return allowed.some((entry) => entry.replace(/\/$/, '') === candidate)
}
