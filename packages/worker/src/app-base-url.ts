import { getDomain } from 'tldts'
import {
	buildPackageAppSubdomainOrigin,
	isDnsSafeUsername,
} from '@kody-internal/shared/public-urls.ts'
import { isNonProductionRuntime } from '#app/deployment-env.ts'

const DEFAULT_APP_BASE_URL = 'https://kody.codes'

type PackageAppBaseUrlEnv = {
	PACKAGE_APP_BASE_URL?: string | null
	WRANGLER_IS_LOCAL_DEV?: string | undefined
}

type AppBaseUrlEnv = PackageAppBaseUrlEnv & {
	APP_BASE_URL?: string | null
}

export type PackageAppOriginEnv = AppBaseUrlEnv & {
	SENTRY_ENVIRONMENT?: string | undefined
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
 * a non-production deployment serves them inline on the app origin.
 *
 * Production must set `PACKAGE_APP_BASE_URL` to a separate registrable domain so
 * author-supplied package code is cross-site from the first-party app origin
 * and can never receive the owner's `kody_session` cookie. Preview, tests, and
 * E2E may leave it unset and keep the path-based same-origin behavior.
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

function getRegistrableDomain(url: URL) {
	return getDomain(url.hostname) ?? url.hostname.toLowerCase()
}

export type PackageAppRequestHost =
	/** The bare package-app origin: serves only redirects, never package code. */
	| { kind: 'apex' }
	/** One user's package-app subdomain: `{username}.<package-app host>`. */
	| { kind: 'user-subdomain'; username: string }
	/**
	 * A hostname under the package-app domain that is not a valid single
	 * username label (nested labels, invalid characters, wrong scheme/port).
	 * Wildcard DNS still routes it here, so it must fail closed.
	 */
	| { kind: 'unrecognized-subdomain' }

/**
 * Classify a request URL against the configured package-app origin.
 *
 * Returns `null` when no package-app origin resolves or when the URL is not
 * on the package-app domain at all (ordinary first-party traffic).
 */
export function parsePackageAppRequestHost(input: {
	env: PackageAppBaseUrlEnv
	url: URL
}): PackageAppRequestHost | null {
	const packageAppOrigin = getPackageAppBaseUrl({ env: input.env })
	if (!packageAppOrigin) return null

	const base = new URL(packageAppOrigin)
	const rawHostname = input.url.hostname.toLowerCase()
	// `URL.hostname` preserves a trailing DNS dot, and `kodyapps.dev.` is the
	// same host as `kodyapps.dev` to resolvers. Letting the dotted form fall
	// through would route it as first-party traffic, so it fails closed as an
	// unrecognized package-app host instead.
	const hadTrailingDot = rawHostname.endsWith('.')
	const hostname = rawHostname.replace(/\.+$/, '')
	if (hostname === base.hostname) {
		if (hadTrailingDot) return { kind: 'unrecognized-subdomain' }
		// Same hostname on a different scheme/port is another local service, not
		// the package-app origin (matches the previous exact-origin behavior).
		return input.url.origin === base.origin ? { kind: 'apex' } : null
	}
	if (!hostname.endsWith(`.${base.hostname}`)) return null
	if (hadTrailingDot) return { kind: 'unrecognized-subdomain' }

	const label = hostname.slice(0, -(base.hostname.length + 1))
	// Strict DNS-label check: legacy underscore usernames cannot own a
	// subdomain, and nested labels never match.
	if (label.includes('.') || !isDnsSafeUsername(label)) {
		return { kind: 'unrecognized-subdomain' }
	}
	const expectedOrigin = buildPackageAppSubdomainOrigin({
		packageAppOrigin,
		username: label,
	})
	if (input.url.origin !== expectedOrigin) {
		return { kind: 'unrecognized-subdomain' }
	}
	return { kind: 'user-subdomain', username: label }
}

/**
 * Return a clear production configuration failure instead of allowing package
 * apps to fall back to the first-party origin.
 */
export function getPackageAppOriginConfigurationError(
	env: PackageAppOriginEnv,
) {
	if (isNonProductionRuntime(env)) return null

	const packageAppOrigin = getPackageAppBaseUrl({ env })
	if (!packageAppOrigin) {
		return 'Production requires PACKAGE_APP_BASE_URL to be set to a valid, separate registrable origin.'
	}

	const configuredAppBaseUrl = env.APP_BASE_URL?.trim()
	if (!configuredAppBaseUrl) {
		return 'Production requires APP_BASE_URL when hosted package apps are enabled.'
	}

	let appOrigin: string
	try {
		appOrigin = new URL(configuredAppBaseUrl).origin
	} catch {
		return 'Production requires APP_BASE_URL to be a valid origin when hosted package apps are enabled.'
	}
	const packageAppUrl = new URL(packageAppOrigin)
	const appUrl = new URL(appOrigin)
	if (
		packageAppUrl.origin === appUrl.origin ||
		getRegistrableDomain(packageAppUrl) === getRegistrableDomain(appUrl)
	) {
		return 'Production requires PACKAGE_APP_BASE_URL to use a separate registrable domain from APP_BASE_URL.'
	}

	return null
}

/**
 * Resolve the public app origin for request-scoped work.
 *
 * Prefer the request origin when a real request URL is available so MCP OAuth
 * metadata and app links match the host the client actually connected to.
 * Fall back to `APP_BASE_URL`, then the production default, for background work
 * (workflows, email, etc.) that has no inbound request.
 *
 * Requests that arrived on the package-app domain (the bare origin or any
 * per-user subdomain) are treated as having no usable request origin: those
 * hosts only serve author-supplied package apps, so first-party links and
 * package runtime callbacks must point at the app origin.
 */
export function getAppBaseUrl(input: {
	env: AppBaseUrlEnv
	requestUrl?: string | URL | null
}) {
	if (input.requestUrl != null && input.requestUrl !== '') {
		try {
			const requestUrl = new URL(input.requestUrl)
			if (!parsePackageAppRequestHost({ env: input.env, url: requestUrl })) {
				return requestUrl.origin
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

/**
 * Resolve the canonical public app origin, preferring the configured
 * `APP_BASE_URL` over the request origin.
 *
 * This is the inverse preference of `getAppBaseUrl`: during a domain
 * migration the Worker dual-serves the canonical host plus legacy hosts
 * (`APP_LEGACY_HOSTS`), and canonical URLs emitted into HTML (`<link
 * rel="canonical">`, OG/Twitter URLs) must point at the configured canonical
 * origin even when the page was served from a legacy host. Request-scoped
 * protocol surfaces (MCP OAuth metadata, app links) keep using
 * `getAppBaseUrl` so they match the host the client actually connected to.
 *
 * Falls back to the request origin (local dev and preview leave
 * `APP_BASE_URL` unset), then the production default.
 */
export function getCanonicalAppBaseUrl(input: {
	env: AppBaseUrlEnv
	requestUrl?: string | URL | null
}) {
	const configuredBaseUrl = input.env.APP_BASE_URL?.trim()
	if (configuredBaseUrl) {
		try {
			return new URL(configuredBaseUrl).origin
		} catch {
			// Runtime env validation should already catch this; fall back defensively.
		}
	}
	return getAppBaseUrl(input)
}

/**
 * Join a first-party app path onto the public origin. Cron and email
 * call sites must use this (or `getAppBaseUrl` + a path) instead of
 * `${APP_BASE_URL}/…`, because production `APP_BASE_URL` may include a
 * trailing slash and would otherwise emit `https://host//path`.
 */
export function joinAppUrl(input: {
	env: AppBaseUrlEnv
	path: string
	requestUrl?: string | URL | null
}) {
	const origin = getAppBaseUrl({
		env: input.env,
		requestUrl: input.requestUrl,
	})
	const path = input.path.startsWith('/') ? input.path : `/${input.path}`
	return `${origin}${path}`
}
