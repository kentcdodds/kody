import { expect, test } from 'vitest'
import { parseAllowedHosts, stringifyAllowedHosts } from './allowed-hosts.ts'
import {
	parseAllowedPackages,
	stringifyAllowedPackages,
} from './allowed-packages.ts'

test('allowed list helpers normalize persisted secret allow lists', () => {
	expect(
		parseAllowedHosts('[" Example.com ","example.com","api.test"]'),
	).toEqual(['api.test', 'example.com'])
	expect(
		parseAllowedHosts(
			'["https://api.linkedin.com","HTTPS://API.LINKEDIN.COM/v2","www.linkedin.com"]',
		),
	).toEqual(['api.linkedin.com', 'www.linkedin.com'])
	expect(stringifyAllowedHosts([' Z.test ', '', 'a.test'])).toBe(
		'["a.test","z.test"]',
	)
	expect(
		stringifyAllowedHosts(['https://api.github.com/path', 'api.github.com']),
	).toBe('["api.github.com"]')

	expect(parseAllowedPackages('[" @scope/B ","@scope/A","@scope/B"]')).toEqual([
		'@scope/A',
		'@scope/B',
	])
	expect(stringifyAllowedPackages([' pkg-b ', '', 'pkg-a'])).toBe(
		'["pkg-a","pkg-b"]',
	)

	expect(parseAllowedHosts('not json')).toEqual([])
	expect(parseAllowedPackages('{"not":"an array"}')).toEqual([])
})
