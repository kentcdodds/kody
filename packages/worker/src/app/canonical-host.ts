import { isNonProductionRuntime } from '#app/deployment-env.ts'
import { parsePackageAppRequestHost } from '#worker/app-base-url.ts'
import { parseLegacyHosts } from '#worker/app-legacy-redirect.ts'

type CanonicalHostEnv = {
	APP_BASE_URL?: string | null
	APP_LEGACY_HOSTS?: string | null
	PACKAGE_APP_BASE_URL?: string | null
	PACKAGE_APP_LEGACY_HOSTS?: string | null
	PACKAGE_APP_LEGACY_REDIRECT?: string | null
	WRANGLER_IS_LOCAL_DEV?: string | undefined
	SENTRY_ENVIRONMENT?: string | undefined
}

function requestHostname(url: URL) {
	return url.hostname.toLowerCase().replace(/\.+$/, '')
}

function configuredAppHostname(env: CanonicalHostEnv) {
	const configured = env.APP_BASE_URL?.trim()
	if (!configured) return null
	try {
		return requestHostname(new URL(configured))
	} catch {
		return null
	}
}

/**
 * Production scripts stay published on `*.workers.dev` so secret bulk-reapply
 * does not drop routes. That hostname is not a product origin: WebAuthn
 * `rpID`, CSP, and CORS assume one canonical host. Preview and local live on
 * `workers.dev` / localhost and must keep serving.
 */
export function isAllowedRequestHost(input: {
	request: Request
	env: CanonicalHostEnv
	allowedHealthPath?: string
}): boolean {
	if (isNonProductionRuntime(input.env)) return true

	let url: URL
	try {
		url = new URL(input.request.url)
	} catch {
		return false
	}

	if (input.allowedHealthPath && url.pathname === input.allowedHealthPath) {
		return true
	}

	const hostname = requestHostname(url)
	if (hostname === configuredAppHostname(input.env)) return true
	if (parseLegacyHosts(input.env.APP_LEGACY_HOSTS).includes(hostname)) {
		return true
	}
	return parsePackageAppRequestHost({ env: input.env, url }) !== null
}

export function createNonCanonicalHostResponse(): Response {
	return Response.json(
		{ error: 'not_found' },
		{
			status: 404,
			headers: { 'Cache-Control': 'no-store' },
		},
	)
}

export function refuseNonCanonicalProductionHost(input: {
	request: Request
	env: CanonicalHostEnv
	allowedHealthPath?: string
}): Response | null {
	if (isAllowedRequestHost(input)) return null
	return createNonCanonicalHostResponse()
}
