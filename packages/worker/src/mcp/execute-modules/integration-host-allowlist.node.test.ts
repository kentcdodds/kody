import { expect, test } from 'vitest'
import {
	assertIntegrationAllowsHost,
	IntegrationHostNotAllowedError,
} from './integration-host-allowlist.ts'

const integration = {
	requiredHosts: ['api.example.com', '[2001:db8::1]'],
	apiBaseUrl: 'https://uploads.example.com/v1',
}

test('a parsed hostname is checked against requiredHosts and the apiBaseUrl host', () => {
	expect(() =>
		assertIntegrationAllowsHost('demo', integration, 'API.example.com'),
	).not.toThrow()
	expect(() =>
		assertIntegrationAllowsHost('demo', integration, 'uploads.example.com'),
	).not.toThrow()
	expect(() =>
		assertIntegrationAllowsHost('demo', integration, '[2001:db8::1]'),
	).not.toThrow()
})

test('an unlisted hostname fails closed, including IPv6 and hosts that are not valid URLs', () => {
	for (const host of ['evil.example', '[::1]', '::1', 'not a host']) {
		expect(() =>
			assertIntegrationAllowsHost('demo', integration, host),
		).toThrow(IntegrationHostNotAllowedError)
	}
	expect(() =>
		assertIntegrationAllowsHost('demo', {}, 'api.example.com'),
	).toThrow('has no allowed hosts configured')
})
