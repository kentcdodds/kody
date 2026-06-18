import {
	normalizeAllowedStringList,
	parseAllowedStringList,
} from './allowed-string-list.ts'

const compareAllowedCapabilities = (left: string, right: string) =>
	left.localeCompare(right)

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
