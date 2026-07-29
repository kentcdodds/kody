const DEFAULT_APP_BASE_URL = 'https://heykody.dev'

type AppBaseUrlEnv = {
	APP_BASE_URL?: string | null
	PACKAGE_APP_BASE_URL?: string | null
}

/**
 * Resolve the origin hosted package apps are served from, or `null` when the
 * deployment serves them inline on the app origin.
 *
 * Production sets `PACKAGE_APP_BASE_URL` to a separate registrable domain so
 * author-supplied package code is cross-site from the first-party app origin
 * and can never receive the owner's `kody_session` cookie. Local dev, preview,
 * and tests leave it unset and keep the path-based same-origin behavior.
 */
export function getPackageAppBaseUrl(input: {
	env: { PACKAGE_APP_BASE_URL?: string | null }
}) {
	const configured = input.env.PACKAGE_APP_BASE_URL?.trim()
	if (!configured) return null

	try {
		return new URL(configured).origin
	} catch {
		// Runtime env validation should already catch this; fall back to the
		// same-origin behavior instead of routing to a bogus host.
		return null
	}
}

/**
 * Resolve the public app origin for request-scoped work.
 *
 * Prefer the request origin when a real request URL is available so MCP OAuth
 * metadata and app links match the host the client actually connected to.
 * Fall back to `APP_BASE_URL`, then the production default, for background work
 * (workflows, email, etc.) that has no inbound request.
 *
 * Requests that arrived on the package-app origin are treated as having no
 * usable request origin: that host only serves author-supplied package apps, so
 * first-party links and package runtime callbacks must point at the app origin.
 */
export function getAppBaseUrl(input: {
	env: AppBaseUrlEnv
	requestUrl?: string | URL | null
}) {
	if (input.requestUrl != null && input.requestUrl !== '') {
		try {
			const requestOrigin = new URL(input.requestUrl).origin
			if (requestOrigin !== getPackageAppBaseUrl({ env: input.env })) {
				return requestOrigin
			}
		} catch {
			// Fall through to configured / default origin.
		}
	}

	const configuredBaseUrl = input.env.APP_BASE_URL?.trim()
	if (configuredBaseUrl) {
		try {
			return new URL(configuredBaseUrl).origin
		} catch {
			// Runtime env validation should already catch this; fall back defensively.
		}
	}

	return DEFAULT_APP_BASE_URL
}
