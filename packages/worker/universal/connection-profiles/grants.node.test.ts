import { describe, expect, test } from 'vitest'
import {
	connectionProfileAllows,
	connectionProfileRevealsResource,
	formatConnectionProfileGrantString,
	normalizeConnectionProfileGrants,
	parseConnectionProfileGrantString,
} from '#universal/connection-profiles/grants.ts'
import {
	buildConnectionProfileMcpUrl,
	getConnectionProfileNameValidationError,
	readConnectionProfileNameFromUrl,
	stripConnectionProfileFromResourceUri,
} from '#universal/connection-profiles/names.ts'

describe('connection profile grants', () => {
	test('absent grants are unlimited; empty named allowlist denies', () => {
		expect(
			connectionProfileAllows({
				grants: null,
				resourceType: 'package',
				resourceId: 'pkg-1',
				action: 'read',
			}),
		).toBe(true)
		expect(
			connectionProfileAllows({
				grants: undefined,
				resourceType: 'package',
				resourceId: 'pkg-1',
				action: 'execute',
			}),
		).toBe(true)
		expect(
			connectionProfileAllows({
				grants: [],
				resourceType: 'package',
				resourceId: 'pkg-1',
				action: 'read',
			}),
		).toBe(false)
		expect(
			connectionProfileRevealsResource({
				grants: [],
				resourceType: 'package',
				resourceId: 'pkg-1',
			}),
		).toBe(false)
	})

	test('read and execute are independent', () => {
		const grants = normalizeConnectionProfileGrants([
			{ resourceType: 'package', resourceId: 'pkg-1', actions: ['read'] },
			{ resourceType: 'package', resourceId: 'pkg-2', actions: ['execute'] },
		])
		expect(
			connectionProfileAllows({
				grants,
				resourceType: 'package',
				resourceId: 'pkg-1',
				action: 'read',
			}),
		).toBe(true)
		expect(
			connectionProfileAllows({
				grants,
				resourceType: 'package',
				resourceId: 'pkg-1',
				action: 'execute',
			}),
		).toBe(false)
		expect(
			connectionProfileAllows({
				grants,
				resourceType: 'package',
				resourceId: 'pkg-2',
				action: 'execute',
			}),
		).toBe(true)
		expect(
			connectionProfileAllows({
				grants,
				resourceType: 'package',
				resourceId: 'pkg-2',
				action: 'read',
			}),
		).toBe(false)
		expect(
			connectionProfileRevealsResource({
				grants,
				resourceType: 'package',
				resourceId: 'pkg-1',
			}),
		).toBe(true)
	})

	test('rejects write and non-package types at normalize', () => {
		expect(() =>
			normalizeConnectionProfileGrants([
				{ resourceType: 'package', resourceId: 'pkg-1', actions: ['write'] },
			]),
		).toThrow(/write/)
		expect(() =>
			normalizeConnectionProfileGrants([
				{ resourceType: 'secret', resourceId: 's1', actions: ['read'] },
			]),
		).toThrow(/secret/)
	})

	test('grant strings round-trip', () => {
		const formatted = formatConnectionProfileGrantString({
			resourceType: 'package',
			resourceId: 'pkg:with:colons',
			action: 'read',
		})
		expect(formatted).toBe('package:pkg:with:colons:read')
		expect(parseConnectionProfileGrantString(formatted)).toEqual({
			resourceType: 'package',
			resourceId: 'pkg:with:colons',
			action: 'read',
		})
	})
})

describe('connection profile names', () => {
	test('rejects Unlimited, empty, and overlong names', () => {
		expect(getConnectionProfileNameValidationError('Unlimited')).toBe(
			'reserved',
		)
		expect(getConnectionProfileNameValidationError('unlimited')).toBe(
			'reserved',
		)
		expect(getConnectionProfileNameValidationError('  ')).toBe('empty')
		expect(getConnectionProfileNameValidationError('x'.repeat(65))).toBe(
			'too_long',
		)
		expect(getConnectionProfileNameValidationError('ok name')).toBeNull()
	})

	test('MCP URL encodes profile and resource strip recovers it', () => {
		const mcpUrl = buildConnectionProfileMcpUrl({
			mcpServerUrl: 'https://kody.codes/mcp',
			profileName: 'CI Bot',
		})
		expect(mcpUrl).toBe('https://kody.codes/mcp?profile=CI+Bot')
		expect(readConnectionProfileNameFromUrl(mcpUrl)).toBe('CI Bot')
		const stripped = stripConnectionProfileFromResourceUri(mcpUrl)
		expect(stripped.profileName).toBe('CI Bot')
		expect(stripped.canonicalResource).toBe('https://kody.codes/mcp')
	})
})
