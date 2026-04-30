import { getAppBaseUrl } from '#app/app-base-url.ts'
import {
	getEmailDomain,
	requireNormalizedEmailAddress,
} from '#worker/email/address.ts'

const defaultLocalDomain = 'local.test'

function normalizeDomain(value: string) {
	return value
		.trim()
		.replace(/^\.+|\.+$/g, '')
		.toLowerCase()
}

function parseDomainFromBaseUrl(value: string | undefined) {
	if (!value?.trim()) return null
	try {
		const hostname = new URL(value).hostname
		return hostname ? normalizeDomain(hostname) : null
	} catch {
		return null
	}
}

export function resolveAppDomain(input: {
	env: {
		APP_DOMAIN?: string | null
		APP_BASE_URL?: string | null
	}
	requestUrl?: string | URL
}) {
	const configuredDomain = input.env.APP_DOMAIN?.trim()
	if (configuredDomain) {
		return normalizeDomain(configuredDomain)
	}
	const fromBaseUrl = parseDomainFromBaseUrl(
		input.env.APP_BASE_URL ?? undefined,
	)
	if (fromBaseUrl) return fromBaseUrl
	if (input.requestUrl) {
		const fromRequestUrl = parseDomainFromBaseUrl(
			getAppBaseUrl({
				env: input.env,
				requestUrl: input.requestUrl,
			}),
		)
		if (fromRequestUrl) return fromRequestUrl
	}
	return defaultLocalDomain
}

export function buildKodySenderAddress(input: {
	env: {
		APP_DOMAIN?: string | null
		APP_BASE_URL?: string | null
	}
	requestUrl?: string | URL
}) {
	const domain = resolveAppDomain(input)
	return requireNormalizedEmailAddress(`kody@${domain}`, 'Kody sender email')
}

export function buildKodySenderIdentity(input: {
	env: {
		APP_DOMAIN?: string | null
		APP_BASE_URL?: string | null
	}
	requestUrl?: string | URL
}) {
	const email = buildKodySenderAddress(input)
	return {
		email,
		displayName: 'Kody',
		domain: getEmailDomain(email),
	}
}
