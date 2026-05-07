function normalizeHost(host: string) {
	return host.trim().toLowerCase()
}

type IntegrationAllowlistInput = {
	apiBaseUrl?: string | null
	requiredHosts?: Array<string>
}

/**
 * Thrown when an outbound request targets a host not in the integration's
 * allowlist (`requiredHosts` + `apiBaseUrl` host). This prevents OAuth tokens
 * from being sent to arbitrary attacker-controlled hosts.
 */
export class IntegrationHostNotAllowedError extends Error {
	override name = 'IntegrationHostNotAllowedError'
	integrationName: string
	disallowedHost: string

	constructor(integrationName: string, disallowedHost: string) {
		super(
			`Integration "${integrationName}" does not allow requests to host "${disallowedHost}". ` +
				`The host must be listed in the integration's requiredHosts or match its apiBaseUrl.`,
		)
		this.integrationName = integrationName
		this.disallowedHost = disallowedHost
	}
}

/**
 * Returns the set of normalized allowed hosts for an integration definition.
 * Includes all `requiredHosts` entries plus the host derived from `apiBaseUrl`.
 */
export function getIntegrationAllowedHosts(
	integration: IntegrationAllowlistInput,
): Array<string> {
	const hosts = new Set<string>()
	if (integration.requiredHosts) {
		for (const host of integration.requiredHosts) {
			const normalized = normalizeHost(host)
			if (normalized) hosts.add(normalized)
		}
	}
	if (integration.apiBaseUrl) {
		try {
			const apiHost = normalizeHost(new URL(integration.apiBaseUrl).hostname)
			if (apiHost) hosts.add(apiHost)
		} catch {
			// apiBaseUrl is not a valid URL; skip
		}
	}
	return Array.from(hosts)
}

/**
 * Asserts that the given URL targets a host allowed by the integration.
 * Throws `IntegrationHostNotAllowedError` if the host is not in the allowlist.
 *
 * Call this **before** attaching any credentials to the outbound request.
 */
export function assertIntegrationHostAllowed(
	integrationName: string,
	integration: IntegrationAllowlistInput,
	url: string | URL | Request,
): void {
	const resolvedUrl = resolveUrlString(url)
	if (!resolvedUrl) return // relative paths will be resolved to apiBaseUrl later

	let requestHost: string
	try {
		requestHost = normalizeHost(new URL(resolvedUrl).hostname)
	} catch {
		return // non-parseable URLs fail at fetch time
	}

	if (!requestHost) return

	const allowedHosts = getIntegrationAllowedHosts(integration)
	if (allowedHosts.length === 0) {
		throw new Error(
			`Integration "${integrationName}" has no allowed hosts configured (requiredHosts and apiBaseUrl are both empty). ` +
				`Cannot attach credentials without a host allowlist.`,
		)
	}

	if (!allowedHosts.includes(requestHost)) {
		throw new IntegrationHostNotAllowedError(integrationName, requestHost)
	}
}

function resolveUrlString(input: string | URL | Request): string | null {
	if (typeof input === 'string') {
		if (input.startsWith('//')) {
			// Protocol-relative URL — resolve with a dummy scheme to extract the host
			return `https:${input}`
		}
		if (input.startsWith('/')) return null
		return input
	}
	if (input instanceof URL) return input.href
	if (input instanceof Request) return input.url
	return null
}
