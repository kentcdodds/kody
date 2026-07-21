import {
	normalizeAllowedStringList,
	parseAllowedStringList,
} from './allowed-string-list.ts'

const compareAllowedCapabilities = (left: string, right: string) =>
	left.localeCompare(right)

/** Max length for one-click capability approval / allowlist entry names. */
export const maxAllowedCapabilityNameLength = 200

/**
 * Conservative identifier pattern for capability names used in secret
 * allowlists. Covers built-ins (`secret_set`), hyphenated names, and
 * namespaced dynamic names (`remote:…`, `mcp:…`, `openapi:…`).
 */
const allowedCapabilityNamePattern = /^[a-zA-Z0-9_.:-]+$/

/**
 * Trim and validate a single capability name for one-click approval and
 * similar privileged policy writes. Returns null when empty, too long, or
 * containing characters outside the safe identifier set.
 */
export function parseAllowedCapabilityName(value: string): string | null {
	const trimmed = value.trim()
	if (
		trimmed.length < 1 ||
		trimmed.length > maxAllowedCapabilityNameLength ||
		!allowedCapabilityNamePattern.test(trimmed)
	) {
		return null
	}
	return trimmed
}

export function normalizeAllowedCapabilities(input: Array<string>) {
	return normalizeAllowedStringList({
		values: input,
		normalizeEntry: (value) => value.trim(),
		compare: compareAllowedCapabilities,
	})
}

export function parseAllowedCapabilities(value: string | null | undefined) {
	return parseAllowedStringList(value, normalizeAllowedCapabilities)
}

export function stringifyAllowedCapabilities(input: Array<string>) {
	return JSON.stringify(normalizeAllowedCapabilities(input))
}
