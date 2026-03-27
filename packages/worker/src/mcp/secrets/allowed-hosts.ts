export function normalizeHost(host: string) {
	return host.trim().toLowerCase()
}

export function normalizeAllowedHosts(hosts: Array<string>) {
	return Array.from(
		new Set(
			hosts
				.map((host) => normalizeHost(host))
				.filter((host) => host.length > 0),
		),
	).sort()
}

export function parseAllowedHosts(raw: string | null | undefined) {
	if (!raw) return []
	try {
		const parsed = JSON.parse(raw)
		return Array.isArray(parsed)
			? normalizeAllowedHosts(
					parsed.filter((value): value is string => typeof value === 'string'),
				)
			: []
	} catch {
		return []
	}
}

export function stringifyAllowedHosts(hosts: Array<string>) {
	return JSON.stringify(normalizeAllowedHosts(hosts))
}
