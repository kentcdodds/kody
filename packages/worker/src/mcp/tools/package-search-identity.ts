import { getUsernameFormatValidationError } from '#worker/identity/username.ts'
import { type SearchMatch } from '#mcp/tools/search-format.ts'
import {
	getSavedPackageById,
	getSavedPackageByKodyId,
} from '#worker/package-registry/repo.ts'
import {
	kodyPackageIdPattern,
	type SavedPackageRecord,
} from '#worker/package-registry/types.ts'

const savedPackageIdPattern =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

type PackageIdentityLookup =
	| {
			kind: 'package-id'
			value: string
			authoritative: boolean
	  }
	| {
			kind: 'kody-id'
			value: string
			authoritative: boolean
	  }

type ParsedPackageIdentity =
	| { kind: 'not-package-identity' }
	| { kind: 'invalid-package-identity' }
	| PackageIdentityLookup

export type PackageIdentitySearchResolution =
	| { recognized: false }
	| {
			recognized: true
			match: Extract<SearchMatch, { type: 'package' }> | null
	  }

function safelyDecodePathSegment(value: string) {
	try {
		return decodeURIComponent(value)
	} catch {
		return null
	}
}

function parsePackageUrl(input: {
	query: string
	baseUrl: string
	packageAppBaseUrl: string | null
	username: string | null
}): ParsedPackageIdentity {
	const looksLikeUrl =
		input.query.startsWith('/') ||
		/^[a-z][a-z\d+.-]*:/i.test(input.query) ||
		input.query.startsWith('//')
	if (!looksLikeUrl) return { kind: 'not-package-identity' }

	let baseUrl: URL
	let url: URL
	try {
		baseUrl = new URL(input.baseUrl)
		url = new URL(input.query, baseUrl)
	} catch {
		return input.query.includes('/packages/')
			? { kind: 'invalid-package-identity' }
			: { kind: 'not-package-identity' }
	}
	// Hosted package apps are served from their own origin in production, so the
	// URL a user copies out of the address bar is on that host, not the app host.
	// Both are this deployment's own origins; anything else is another site's URL
	// and must not resolve to one of this user's packages.
	let packageAppOrigin: string | null = null
	if (input.packageAppBaseUrl) {
		try {
			packageAppOrigin = new URL(input.packageAppBaseUrl).origin
		} catch {
			packageAppOrigin = null
		}
	}

	const parts = url.pathname.split('/').filter(Boolean)
	const isAccountPackagePath =
		parts.length === 3 && parts[0] === 'account' && parts[1] === 'packages'
	const isHostedPackagePath =
		parts.length === 3 && parts[0]?.startsWith('@') && parts[1] === 'packages'
	if (!isAccountPackagePath && !isHostedPackagePath) {
		return { kind: 'not-package-identity' }
	}
	// The package-app origin only serves `/@{username}/packages/*`; account pages
	// live on the app origin alone.
	const isOwnOrigin =
		url.origin === baseUrl.origin ||
		(isHostedPackagePath &&
			packageAppOrigin !== null &&
			url.origin === packageAppOrigin)
	if (!isOwnOrigin || url.username.length > 0 || url.password.length > 0) {
		return { kind: 'invalid-package-identity' }
	}

	if (isAccountPackagePath) {
		const packageId = safelyDecodePathSegment(parts[2] ?? '')
		return packageId && savedPackageIdPattern.test(packageId)
			? { kind: 'package-id', value: packageId, authoritative: true }
			: { kind: 'invalid-package-identity' }
	}

	const owner = safelyDecodePathSegment(parts[0]?.slice(1) ?? '')
	const kodyId = safelyDecodePathSegment(parts[2] ?? '')
	if (
		!owner ||
		!kodyId ||
		getUsernameFormatValidationError(owner) ||
		!kodyPackageIdPattern.test(kodyId) ||
		owner !== input.username
	) {
		return { kind: 'invalid-package-identity' }
	}
	return { kind: 'kody-id', value: kodyId, authoritative: true }
}

export function parsePackageSearchIdentity(input: {
	query: string
	baseUrl: string
	/** Origin hosted package apps are served from, when it is a separate host. */
	packageAppBaseUrl?: string | null
	username: string | null
}): ParsedPackageIdentity {
	const query = input.query.trim()
	if (!query) return { kind: 'not-package-identity' }

	const parsedUrl = parsePackageUrl({
		query,
		baseUrl: input.baseUrl,
		packageAppBaseUrl: input.packageAppBaseUrl ?? null,
		username: input.username,
	})
	if (parsedUrl.kind !== 'not-package-identity') return parsedUrl
	if (savedPackageIdPattern.test(query)) {
		return { kind: 'package-id', value: query, authoritative: true }
	}
	if (kodyPackageIdPattern.test(query)) {
		return { kind: 'kody-id', value: query, authoritative: false }
	}
	return { kind: 'not-package-identity' }
}

function toPackageSearchMatch(
	record: SavedPackageRecord,
): Extract<SearchMatch, { type: 'package' }> {
	return {
		type: 'package',
		packageId: record.id,
		kodyId: record.kodyId,
		name: record.name,
		title: record.name,
		description: record.description,
		tags: record.tags,
		hasApp: record.hasApp,
		hidden: record.hidden,
		readmeSnippet: null,
		actionMatches: [],
	}
}

export async function resolvePackageIdentitySearch(input: {
	db: D1Database
	userId: string | null
	query: string
	baseUrl: string
	packageAppBaseUrl?: string | null
	username: string | null
	includeHiddenPackages: boolean
}): Promise<PackageIdentitySearchResolution> {
	const identity = parsePackageSearchIdentity(input)
	if (identity.kind === 'not-package-identity') return { recognized: false }
	if (identity.kind === 'invalid-package-identity' || !input.userId) {
		return { recognized: true, match: null }
	}

	const record =
		identity.kind === 'package-id'
			? await getSavedPackageById(input.db, {
					userId: input.userId,
					packageId: identity.value,
				})
			: await getSavedPackageByKodyId(input.db, {
					userId: input.userId,
					kodyId: identity.value,
				})
	if (!record) {
		return identity.authoritative
			? { recognized: true, match: null }
			: { recognized: false }
	}
	if (record.hidden && !input.includeHiddenPackages) {
		return { recognized: true, match: null }
	}
	return { recognized: true, match: toPackageSearchMatch(record) }
}
