import {
	normalizeHost,
	normalizeAllowedHosts,
} from '#mcp/secrets/allowed-hosts.ts'

export function normalizeProviderHosts(hosts: Array<string>) {
	return normalizeAllowedHosts(hosts).filter((host) => host.length > 0)
}

export function providerHostsAllowRequestHost(
	hosts: Array<string>,
	requestHost: string,
) {
	const normalizedRequest = normalizeHost(requestHost)
	if (!normalizedRequest) return false
	const usable = normalizeProviderHosts(hosts)
	if (usable.length === 0) return false
	return usable.includes(normalizedRequest)
}
