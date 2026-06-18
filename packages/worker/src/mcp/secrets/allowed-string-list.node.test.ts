import { expect, test } from 'vitest'
import {
	parseAllowedCapabilities,
	stringifyAllowedCapabilities,
} from './allowed-capabilities.ts'
import { parseAllowedHosts, stringifyAllowedHosts } from './allowed-hosts.ts'
import {
	parseAllowedPackages,
	stringifyAllowedPackages,
} from './allowed-packages.ts'

test('allowed hosts normalize case, trim, dedupe, and sort', () => {
	expect(parseAllowedHosts('[" Example.com ","example.com","api.test"]')).toEqual(
		['api.test', 'example.com'],
	)
	expect(stringifyAllowedHosts([' Z.test ', '', 'a.test'])).toBe(
		'["a.test","z.test"]',
	)
})

test('allowed packages trim, dedupe, and sort without lowercasing', () => {
	expect(parseAllowedPackages('[" @scope/B ","@scope/A","@scope/B"]')).toEqual(
		['@scope/A', '@scope/B'],
	)
	expect(stringifyAllowedPackages([' pkg-b ', '', 'pkg-a'])).toBe(
		'["pkg-a","pkg-b"]',
	)
})

test('allowed capabilities trim, dedupe, and sort without lowercasing', () => {
	expect(
		parseAllowedCapabilities('["capability_b"," capability_a ","capability_b"]'),
	).toEqual(['capability_a', 'capability_b'])
	expect(stringifyAllowedCapabilities([' capability_b ', '', 'capability_a'])).toBe(
		'["capability_a","capability_b"]',
	)
})

test('allowed lists fall back to empty lists for malformed values', () => {
	expect(parseAllowedHosts('not json')).toEqual([])
	expect(parseAllowedPackages('{"not":"an array"}')).toEqual([])
	expect(parseAllowedCapabilities(null)).toEqual([])
})
