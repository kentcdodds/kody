/** Matches server `normalizeAllowedHosts` in `#mcp/secrets/allowed-hosts.ts`. */
function normalizeHost(host: string) {
	const trimmed = host.trim().toLowerCase()
	if (!trimmed.startsWith('http://') && !trimmed.startsWith('https://')) {
		return trimmed
	}
	try {
		return new URL(trimmed).hostname
	} catch {
		const withoutScheme = trimmed.replace(/^https?:\/\//, '')
		const slash = withoutScheme.indexOf('/')
		return slash === -1 ? withoutScheme : withoutScheme.slice(0, slash)
	}
}

export function normalizeAllowedHosts(hosts: Array<string>): Array<string> {
	return Array.from(
		new Set(
			hosts
				.map((host) => normalizeHost(host))
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

/** Matches server `normalizeAllowedPackages` in `#mcp/secrets/allowed-packages.ts`. */
export function normalizeAllowedPackages(
	packages: Array<string>,
): Array<string> {
	return Array.from(
		new Set(
			packages.map((value) => value.trim()).filter((value) => value.length > 0),
		),
	).sort((left, right) => left.localeCompare(right))
}
