import {
	normalizeAllowedStringList,
	parseAllowedStringList,
} from './allowed-string-list.ts'

export function normalizeHost(host: string) {
	return host.trim().toLowerCase()
}

export function normalizeAllowedHosts(hosts: Array<string>) {
	return normalizeAllowedStringList({
		values: hosts,
		normalizeEntry: normalizeHost,
	})
}

export function parseAllowedHosts(raw: string | null | undefined) {
	return parseAllowedStringList(raw, normalizeAllowedHosts)
}

export function stringifyAllowedHosts(hosts: Array<string>) {
	return JSON.stringify(normalizeAllowedHosts(hosts))
}
