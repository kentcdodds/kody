const DEFAULT_APP_BASE_URL = 'https://heykody.dev'

type PackageAppBaseUrlEnv = {
	PACKAGE_APP_BASE_URL?: string | null
	WRANGLER_IS_LOCAL_DEV?: string | undefined
}

type AppBaseUrlEnv = PackageAppBaseUrlEnv & {
	APP_BASE_URL?: string | null
}

function isLocallyServableHostname(hostname: string) {
	return (
		hostname === 'localhost' ||
		hostname === '127.0.0.1' ||
		hostname === '[::1]' ||
		hostname.endsWith('.localhost')
	)
}

/**
 * Resolve the origin hosted package apps are served from, or `null` when the
 * deployment serves them inline on the app origin.
 *
 * Production sets `PACKAGE_APP_BASE_URL` to a separate registrable domain so
 * author-supplied package code is cross-site from the first-party app origin
 * and can never receive the owner's `kody_session` cookie. Preview, tests, and
 * E2E leave it unset and keep the path-based same-origin behavior.
 *
 * `npm run dev` runs against the **production** Wrangler environment, so the
 * committed production value reaches local dev too. A local server cannot serve
 * the real package-app domain, so local dev only honors an origin it can
 * actually answer on (`localhost`, `127.0.0.1`, `*.localhost`) — set
 * `PACKAGE_APP_BASE_URL=http://packages.localhost:<port>` in
 * `packages/worker/.env` to exercise the two-origin flow locally.
 */
export function getPackageAppBaseUrl(input: { env: PackageAppBaseUrlEnv }) {
	const configured = input.env.PACKAGE_APP_BASE_URL?.trim()
	if (!configured) return null

	try {
		const configuredUrl = new URL(configured)
		// Exact 'true' like `isNonProductionRuntime`: any other value must not be
		// able to switch package apps back to the app origin in a real deployment.
		if (
			input.env.WRANGLER_IS_LOCAL_DEV === 'true' &&
			!isLocallyServableHostname(configuredUrl.hostname)
		) {
			return null
		}
		return configuredUrl.origin
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
