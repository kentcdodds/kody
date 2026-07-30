import { expect, test } from 'vitest'
import { normalizeAllowedCapabilities as serverNormalizeAllowedCapabilities } from '#mcp/secrets/allowed-capabilities.ts'
import { normalizeAllowedHosts as serverNormalizeAllowedHosts } from '#mcp/secrets/allowed-hosts.ts'
import { normalizeAllowedPackages as serverNormalizeAllowedPackages } from '#mcp/secrets/allowed-packages.ts'
import {
	normalizeAllowedCapabilities,
	normalizeAllowedHosts,
	normalizeAllowedPackages,
} from './secret-normalization.ts'

test('client secret allowlist normalizers match server and collapse empties/duplicates', () => {
	expect(() => new URL('https://exa mple.com/path')).toThrow()

	const hostFixtures = [
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
	const hostResult = normalizeAllowedHosts(hostFixtures)
	expect(hostResult).toEqual(serverNormalizeAllowedHosts(hostFixtures))
	expect(hostResult).toEqual([
		'api.example.com',
		'api.github.com',
		'exa mple.com',
		'example.com',
		'example.org',
		'github.com',
	])
	expect(normalizeAllowedHosts(['', '   ', 'dup.test', 'dup.test'])).toEqual([
		'dup.test',
	])

	const capabilityFixtures = [
		'  secret_set  ',
		'mcp:github',
		'remote:home',
		'a',
		'B',
		'secret_set',
		'',
		'   ',
	]
	const capabilityResult = normalizeAllowedCapabilities(capabilityFixtures)
	expect(capabilityResult).toEqual(
		serverNormalizeAllowedCapabilities(capabilityFixtures),
	)
	expect(capabilityResult).toEqual([
		'a',
		'B',
		'mcp:github',
		'remote:home',
		'secret_set',
	])
	expect(normalizeAllowedCapabilities(['', '  ', 'cap_a', 'cap_a'])).toEqual([
		'cap_a',
	])

	const packageFixtures = [
		' @owner/pkg ',
		'@owner/other',
		'a',
		'B',
		' @owner/pkg ',
		'',
		'   ',
	]
	const packageResult = normalizeAllowedPackages(packageFixtures)
	expect(packageResult).toEqual(serverNormalizeAllowedPackages(packageFixtures))
	expect(packageResult).toEqual(['@owner/other', '@owner/pkg', 'a', 'B'])
	expect(
		normalizeAllowedPackages(['', '  ', '@scope/pkg', '@scope/pkg']),
	).toEqual(['@scope/pkg'])
})
