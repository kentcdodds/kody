function normalizeHost(host: string) {
	return host.trim().toLowerCase()
}

type ConnectorAllowlistInput = {
	apiBaseUrl?: string | null
	requiredHosts?: Array<string>
}

/**
 * Thrown when an outbound request targets a host not in the connector's
 * allowlist (`requiredHosts` + `apiBaseUrl` host). This prevents OAuth tokens
 * from being sent to arbitrary attacker-controlled hosts.
 */
export class ConnectorHostNotAllowedError extends Error {
	override name = 'ConnectorHostNotAllowedError'
	connectorName: string
	disallowedHost: string

	constructor(connectorName: string, disallowedHost: string) {
		super(
			`Connector "${connectorName}" does not allow requests to host "${disallowedHost}". ` +
				`The host must be listed in the connector's requiredHosts or match its apiBaseUrl.`,
		)
		this.connectorName = connectorName
		this.disallowedHost = disallowedHost
	}
}

/**
 * Returns the set of normalized allowed hosts for a connector definition.
 * Includes all `requiredHosts` entries plus the host derived from `apiBaseUrl`.
 */
export function getConnectorAllowedHosts(
	connector: ConnectorAllowlistInput,
): Array<string> {
	const hosts = new Set<string>()
	if (connector.requiredHosts) {
		for (const host of connector.requiredHosts) {
			const normalized = normalizeHost(host)
			if (normalized) hosts.add(normalized)
		}
	}
	if (connector.apiBaseUrl) {
		try {
			const apiHost = normalizeHost(new URL(connector.apiBaseUrl).hostname)
			if (apiHost) hosts.add(apiHost)
		} catch {
			// apiBaseUrl is not a valid URL; skip
		}
	}
	return Array.from(hosts)
}

/**
 * Asserts that the given URL targets a host allowed by the connector.
 * Throws `ConnectorHostNotAllowedError` if the host is not in the allowlist.
 *
 * Call this **before** attaching any credentials to the outbound request.
 */
export function assertConnectorHostAllowed(
	connectorName: string,
	connector: ConnectorAllowlistInput,
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

	const allowedHosts = getConnectorAllowedHosts(connector)
	if (allowedHosts.length === 0) return // no allowlist defined; cannot enforce

	if (!allowedHosts.includes(requestHost)) {
		throw new ConnectorHostNotAllowedError(connectorName, requestHost)
	}
}

function resolveUrlString(input: string | URL | Request): string | null {
	if (typeof input === 'string') {
		if (input.startsWith('/')) return null // relative path
		return input
	}
	if (input instanceof URL) return input.href
	if (input instanceof Request) return input.url
	return null
}
