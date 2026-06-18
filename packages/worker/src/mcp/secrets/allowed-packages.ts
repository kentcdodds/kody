import {
	normalizeAllowedStringList,
	parseAllowedStringList,
} from './allowed-string-list.ts'

const compareAllowedPackages = (left: string, right: string) =>
	left.localeCompare(right)

export function normalizeAllowedPackages(input: Array<string>) {
	return normalizeAllowedStringList({
		values: input,
		normalizeEntry: (value) => value.trim(),
		compare: compareAllowedPackages,
	})
}

export function parseAllowedPackages(value: string | null | undefined) {
	return parseAllowedStringList(value, normalizeAllowedPackages)
}

export function stringifyAllowedPackages(input: Array<string>) {
	return JSON.stringify(normalizeAllowedPackages(input))
}
