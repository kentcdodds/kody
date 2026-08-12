export function buildUsernamePathPrefix(username: string) {
	return `/@${encodeURIComponent(username.trim())}`
}

function buildRestPathSuffix(restPath: string | null | undefined) {
	const trimmed = restPath?.trim()
	return trimmed ? `/${trimmed.replace(/^\/+/, '')}` : ''
}

export function buildPackageAppPath(input: {
	username: string
	kodyId: string
	restPath?: string | null
}) {
	return `${buildUsernamePathPrefix(input.username)}/packages/${encodeURIComponent(
		input.kodyId.trim(),
	)}${buildRestPathSuffix(input.restPath)}`
}

export function buildPackageAppUrl(input: {
	origin: string
	username: string
	kodyId: string
	restPath?: string | null
}) {
	return `${input.origin.trim().replace(/\/+$/, '')}${buildPackageAppPath(input)}`
}

/**
 * How a package-app URL addresses its package:
 *
 * - `user-subdomain`: `https://{username}.<package-app host>/packages/{kodyId}`
 *   — the production shape, where the username lives in the hostname.
 * - `username-path`: `/@{username}/packages/{kodyId}` — the app-origin entry
 *   point (which redirects into the handoff) and the non-production inline
 *   serving shape.
 */
export type PackageAppMount = 'user-subdomain' | 'username-path'

/**
 * The username shape: a valid DNS label (lowercase letters, digits, hyphens;
 * 3–32 chars; alphanumeric edges), because every user owns a `{username}.`
 * subdomain on the package-app domain. Also used to validate subdomain labels
 * from wildcard-routed hostnames, which can be arbitrary strings.
 */
export const dnsSafeUsernamePattern = /^[a-z0-9](?:[a-z0-9-]{1,30}[a-z0-9])$/

export function isDnsSafeUsername(username: string) {
	return dnsSafeUsernamePattern.test(username.trim())
}

/**
 * Path for a hosted package app on its per-user package-app subdomain. The
 * username lives in the hostname there, so the path carries only the package
 * mount: `/packages/{kodyId}/{rest}`.
 */
export function buildPackageAppSubdomainPath(input: {
	kodyId: string
	restPath?: string | null
}) {
	return `/packages/${encodeURIComponent(input.kodyId.trim())}${buildRestPathSuffix(
		input.restPath,
	)}`
}

/**
 * Origin of one user's package-app subdomain: `{username}.` prefixed onto the
 * configured package-app origin's hostname, preserving scheme and port.
 *
 * The username must already satisfy the username format rules (lowercase DNS
 * label); this function does not re-validate it.
 */
export function buildPackageAppSubdomainOrigin(input: {
	packageAppOrigin: string
	username: string
}) {
	const username = input.username.trim().toLowerCase()
	if (!username) {
		throw new Error('Username is required to build a package-app subdomain.')
	}
	const url = new URL(input.packageAppOrigin)
	url.hostname = `${username}.${url.hostname}`
	return url.origin
}

export function buildPackageAppSubdomainUrl(input: {
	packageAppOrigin: string
	username: string
	kodyId: string
	restPath?: string | null
}) {
	return `${buildPackageAppSubdomainOrigin(input)}${buildPackageAppSubdomainPath(input)}`
}

/**
 * Canonical browser URL for a hosted package app: the per-user subdomain of
 * the package-app origin when one is configured, or the path-based mount on
 * the app origin when a non-production deployment serves package apps inline.
 */
export function resolveHostedPackageAppUrl(input: {
	packageAppBaseUrl: string | null
	appBaseUrl: string
	username: string
	kodyId: string
	restPath?: string | null
}) {
	if (input.packageAppBaseUrl) {
		return buildPackageAppSubdomainUrl({
			packageAppOrigin: input.packageAppBaseUrl,
			username: input.username,
			kodyId: input.kodyId,
			restPath: input.restPath,
		})
	}
	return buildPackageAppUrl({
		origin: input.appBaseUrl,
		username: input.username,
		kodyId: input.kodyId,
		restPath: input.restPath,
	})
}

export const packageInvocationRootExportRouteSegment = '__root__'

export function normalizePackageInvocationExportName(exportName: string) {
	const trimmed = exportName.trim()
	if (!trimmed) {
		throw new Error('Package export name must not be empty.')
	}
	if (trimmed === '.' || trimmed === './') {
		return '.'
	}
	return trimmed.startsWith('./') ? trimmed : `./${trimmed}`
}

export function buildPackageInvocationRouteExportName(exportName: string) {
	const normalized = normalizePackageInvocationExportName(exportName)
	if (normalized === '.') return packageInvocationRootExportRouteSegment
	return normalized.startsWith('./') ? normalized.slice(2) : normalized
}

export function buildPackageInvocationPath(input: {
	username: string
	kodyId: string
	exportName: string
}) {
	return `${buildUsernamePathPrefix(input.username)}/api/package-invocations/${encodeURIComponent(
		input.kodyId.trim(),
	)}/${encodeURIComponent(buildPackageInvocationRouteExportName(input.exportName))}`
}

export function buildPackageInvocationUrl(input: {
	origin: string
	username: string
	kodyId: string
	exportName: string
}) {
	return `${input.origin.trim().replace(/\/+$/, '')}${buildPackageInvocationPath(input)}`
}

export function requireUsernameForPublicUrl(
	username: string | null | undefined,
) {
	if (!username) {
		throw new Error(
			'Username is required to build username-scoped public URLs.',
		)
	}
	return username
}
