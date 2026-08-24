import { getCanonicalAppBaseUrl } from '#worker/app-base-url.ts'
import { parseLegacyHosts } from '#worker/app-legacy-redirect.ts'
import { getSystemEmailDomain } from '#worker/email/platform-address.ts'

export type TransactionalEmailEnv = {
	APP_BASE_URL?: string | null
	SYSTEM_EMAIL_DOMAIN?: string | null
	LEGACY_SYSTEM_EMAIL_DOMAINS?: string | null
	WRANGLER_IS_LOCAL_DEV?: string
}

export type TransactionalEmailConfig = {
	/** Absolute origin used for action links and email assets. */
	appBaseUrl: string
	/** Platform transactional sender: `kody@<sending domain>`. */
	fromEmail: string
}

const canonicalPublicOrigin = 'https://kody.codes'
const bakedInLegacyOutboundHosts: ReadonlyArray<string> = [
	'heykody.app',
	'heykody.dev',
]

function tryOrigin(value: string | URL | null | undefined) {
	if (value == null || value === '') return null
	try {
		return new URL(value).origin
	} catch {
		return null
	}
}

function isLegacyOutboundHost(hostname: string, env: TransactionalEmailEnv) {
	const host = hostname.toLowerCase()
	if (bakedInLegacyOutboundHosts.includes(host)) {
		return true
	}
	return parseLegacyHosts(env.LEGACY_SYSTEM_EMAIL_DOMAINS).includes(host)
}

function remapOutboundHost(hostname: string, env: TransactionalEmailEnv) {
	if (!isLegacyOutboundHost(hostname, env)) return hostname
	const systemDomain = getSystemEmailDomain(env)
	if (systemDomain && !isLegacyOutboundHost(systemDomain, env)) {
		return systemDomain
	}
	return new URL(canonicalPublicOrigin).hostname
}

/**
 * Resolve the From address and link origin for signup, email-change,
 * password-reset, and entitlement-warning mail.
 *
 * From follows `SYSTEM_EMAIL_DOMAIN` when set, otherwise the worker hostname
 * (`APP_BASE_URL`, else the request host). Links follow that worker origin
 * so preview mail points at the preview worker. A leftover `heykody.app` /
 * `heykody.dev` origin — or any `LEGACY_SYSTEM_EMAIL_DOMAINS` host — remaps
 * both From and links to `SYSTEM_EMAIL_DOMAIN` when that override is a
 * current host, otherwise `kody.codes`. Local `npm run dev` keeps clickable
 * links on the request origin so signup still works against localhost.
 */
export function resolveTransactionalEmailConfig(input: {
	env: TransactionalEmailEnv
	requestUrl?: string | URL | null
}): TransactionalEmailConfig | null {
	const requestOrigin = tryOrigin(input.requestUrl)
	const configuredOrigin = tryOrigin(input.env.APP_BASE_URL?.trim())
	const systemDomain = getSystemEmailDomain(input.env)
	if (!configuredOrigin && !requestOrigin && !systemDomain) return null

	const workerOrigin = getCanonicalAppBaseUrl({
		env: input.env,
		requestUrl: input.requestUrl,
	})
	const workerHost = new URL(workerOrigin).hostname
	const fromHost = remapOutboundHost(systemDomain ?? workerHost, input.env)

	const fromEmail = `kody@${fromHost}`
	if (input.env.WRANGLER_IS_LOCAL_DEV === 'true') {
		const localOrigin = requestOrigin ?? configuredOrigin
		if (localOrigin) return { appBaseUrl: localOrigin, fromEmail }
	}

	const linkHost = remapOutboundHost(workerHost, input.env)
	const appBaseUrl =
		linkHost === workerHost ? workerOrigin : `https://${linkHost}`
	return { appBaseUrl, fromEmail }
}
