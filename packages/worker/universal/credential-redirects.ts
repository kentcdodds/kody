/**
 * Old credential URLs and where they now live (contract: "Redirects"). Only
 * index pages move; approval and OAuth flows under them keep serving, and
 * `/connect/oauth` never moves because it is a registered OAuth redirect URI.
 */
import {
	credentialCreatePath,
	type CredentialKind,
} from './credential-contracts.ts'

/**
 * Secret providers is not here: granting a vault access is its own trust
 * decision with its own audit trail, so that page stays separate.
 */
const orgIndexRedirects: Record<string, CredentialKind> = {
	secrets: 'secret',
	integrations: 'oauth',
	'mcp-servers': 'mcp',
}

const orgIndexPattern = /^\/@([^/]+)\/-\/([^/]+)\/?$/

function withSearch(path: string, search: URLSearchParams) {
	const query = search.toString()
	return query ? `${path}?${query}` : path
}

function orgIndexRedirect(url: URL): string | null {
	const match = orgIndexPattern.exec(url.pathname)
	if (!match) return null
	const [, orgSegment, section] = match
	if (!section || !Object.hasOwn(orgIndexRedirects, section)) return null
	const search = new URLSearchParams(url.searchParams)
	search.set('kind', orgIndexRedirects[section]!)
	return withSearch(`/@${orgSegment}/-/credentials`, search)
}

/**
 * `/connect/secret-set` reads `package` as an allowed package id; the creation
 * link reserves `forPackage` for the package a need belongs to, so `package`
 * becomes `allowedPackages`.
 */
function connectSecretSetRedirect(url: URL): string {
	const search = new URLSearchParams()
	search.set('kind', 'secret')
	for (const [name, value] of url.searchParams) {
		if (name === 'kind') continue
		search.append(name === 'package' ? 'allowedPackages' : name, value)
	}
	return withSearch(credentialCreatePath, search)
}

/** The new path and query for an old credential URL, or null to keep serving. */
export function credentialRedirectFor(url: URL): string | null {
	if (url.pathname === '/connect/secret-set') {
		return connectSecretSetRedirect(url)
	}
	return orgIndexRedirect(url)
}
