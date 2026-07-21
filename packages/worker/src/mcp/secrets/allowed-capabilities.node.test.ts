import { expect, test } from 'vitest'
import {
	maxAllowedCapabilityNameLength,
	parseAllowedCapabilityName,
} from './allowed-capabilities.ts'

test('parseAllowedCapabilityName accepts real capability identifier forms', () => {
	expect(parseAllowedCapabilityName('secret_set')).toBe('secret_set')
	expect(parseAllowedCapabilityName('  secret_jwt_sign  ')).toBe(
		'secret_jwt_sign',
	)
	expect(
		parseAllowedCapabilityName('remote:home:lighting_lutron_set_credentials'),
	).toBe('remote:home:lighting_lutron_set_credentials')
	expect(parseAllowedCapabilityName('mcp:linear:create_issue')).toBe(
		'mcp:linear:create_issue',
	)
	expect(parseAllowedCapabilityName('openapi:widgets:createwidget')).toBe(
		'openapi:widgets:createwidget',
	)
	expect(
		parseAllowedCapabilityName(
			'remote:lighting:lutron_set_credentials-resolved',
		),
	).toBe('remote:lighting:lutron_set_credentials-resolved')
	expect(
		parseAllowedCapabilityName('a'.repeat(maxAllowedCapabilityNameLength)),
	).toBe('a'.repeat(maxAllowedCapabilityNameLength))
})

test('parseAllowedCapabilityName rejects empty, oversized, and unsafe names', () => {
	expect(parseAllowedCapabilityName('')).toBeNull()
	expect(parseAllowedCapabilityName('   ')).toBeNull()
	expect(parseAllowedCapabilityName('evil name<script>')).toBeNull()
	expect(parseAllowedCapabilityName('secret set')).toBeNull()
	expect(parseAllowedCapabilityName('secret/set')).toBeNull()
	expect(parseAllowedCapabilityName('secret$set')).toBeNull()
	expect(parseAllowedCapabilityName("secret'set")).toBeNull()
	expect(parseAllowedCapabilityName('secret\nset')).toBeNull()
	expect(
		parseAllowedCapabilityName('a'.repeat(maxAllowedCapabilityNameLength + 1)),
	).toBeNull()
})
