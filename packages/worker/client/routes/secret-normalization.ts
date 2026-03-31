/** Matches server `normalizeAllowedHosts` in `#mcp/secrets/allowed-hosts.ts`. */
export function normalizeAllowedHosts(hosts: Array<string>): Array<string> {
	return Array.from(
		new Set(
			hosts
				.map((host) => host.trim().toLowerCase())
				.filter((host) => host.length > 0),
		),
	).sort()
}

/** Matches server `normalizeAllowedCapabilities` in `#mcp/secrets/allowed-capabilities.ts`. */
export function normalizeAllowedCapabilities(
	capabilities: Array<string>,
): Array<string> {
	return Array.from(
		new Set(
			capabilities
				.map((value) => value.trim())
				.filter((value) => value.length > 0),
		),
	).sort((left, right) => left.localeCompare(right))
}
