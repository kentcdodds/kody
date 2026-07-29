import { expect, test } from 'vitest'
import { normalizeAllowedCapabilities as serverNormalizeAllowedCapabilities } from '#mcp/secrets/allowed-capabilities.ts'
import { normalizeAllowedHosts as serverNormalizeAllowedHosts } from '#mcp/secrets/allowed-hosts.ts'
import { normalizeAllowedPackages as serverNormalizeAllowedPackages } from '#mcp/secrets/allowed-packages.ts'
import {
	normalizeAllowedCapabilities,
	normalizeAllowedHosts,
	normalizeAllowedPackages,
} from './secret-normalization.ts'

const hostFixtures: Array<string> = [
	'api.example.com',
	'API.EXAMPLE.COM',
	'  github.com  ',
	'https://api.github.com',
	'http://example.org',
	'https://api.example.com:8443/v1/path',
	// Space in hostname makes `new URL` throw; both sides use the catch fallback.
	'https://exa mple.com/path',
	'api.example.com',
	'',
	'   ',
	'example.com',
]

const capabilityFixtures: Array<string> = [
	'  secret_set  ',
	'mcp:github',
	'remote:home',
	'a',
	'B',
	'secret_set',
	'',
	'   ',
]

const packageFixtures: Array<string> = [
	' @owner/pkg ',
	'@owner/other',
	'a',
	'B',
	' @owner/pkg ',
	'',
	'   ',
]

test('normalizeAllowedHosts matches server normalization for shared fixtures', () => {
	expect(() => new URL('https://exa mple.com/path')).toThrow()

	const clientResult = normalizeAllowedHosts(hostFixtures)
	const serverResult = serverNormalizeAllowedHosts(hostFixtures)

	expect(clientResult).toEqual(serverResult)
	expect(clientResult).toEqual([
		'api.example.com',
		'api.github.com',
		'exa mple.com',
		'example.com',
		'example.org',
		'github.com',
	])
})

test('normalizeAllowedCapabilities matches server normalization for shared fixtures', () => {
	const clientResult = normalizeAllowedCapabilities(capabilityFixtures)
	const serverResult = serverNormalizeAllowedCapabilities(capabilityFixtures)

	expect(clientResult).toEqual(serverResult)
	// localeCompare order differs from default `.sort()` for ['a', 'B'].
	expect(['a', 'B'].sort()).toEqual(['B', 'a'])
	expect(['a', 'B'].sort((left, right) => left.localeCompare(right))).toEqual([
		'a',
		'B',
	])
	expect(clientResult).toEqual([
		'a',
		'B',
		'mcp:github',
		'remote:home',
		'secret_set',
	])
})

test('normalizeAllowedPackages matches server normalization for shared fixtures', () => {
	const clientResult = normalizeAllowedPackages(packageFixtures)
	const serverResult = serverNormalizeAllowedPackages(packageFixtures)

	expect(clientResult).toEqual(serverResult)
	expect(clientResult).toEqual(['@owner/other', '@owner/pkg', 'a', 'B'])
})

test('secret normalization helpers filter empties and collapse duplicates', () => {
	expect(normalizeAllowedHosts(['', '   ', 'dup.test', 'dup.test'])).toEqual([
		'dup.test',
	])
	expect(normalizeAllowedCapabilities(['', '  ', 'cap_a', 'cap_a'])).toEqual([
		'cap_a',
	])
	expect(
		normalizeAllowedPackages(['', '  ', '@scope/pkg', '@scope/pkg']),
	).toEqual(['@scope/pkg'])
})
