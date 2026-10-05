import { expect, test } from 'vitest'
import { buildSecretSetupUrl } from './secret-setup-url.ts'

test('buildSecretSetupUrl points at the focused /connect/secret-set page', () => {
	expect(
		buildSecretSetupUrl({
			baseUrl: 'https://kody.codes',
			name: 'exampleApiKey',
			description: 'Example API key',
			expiresAt: '2026-12-01T00:00:00.000Z',
			allowedHosts: ['api.example.com'],
			allowedPackages: ['pkg_123'],
			scope: 'user',
		}),
	).toBe(
		'https://kody.codes/connect/secret-set?name=exampleApiKey&description=Example+API+key&expiresAt=2026-12-01T00%3A00%3A00.000Z&allowedHosts=api.example.com&allowedPackages=pkg_123&scope=user',
	)

	expect(
		buildSecretSetupUrl({
			baseUrl: 'https://kody.codes',
			name: 'packageToken',
			scope: 'package',
			packageId: 'pkg_abc',
		}),
	).toBe(
		'https://kody.codes/connect/secret-set?name=packageToken&scope=package&packageId=pkg_abc',
	)

	expect(() =>
		buildSecretSetupUrl({
			baseUrl: 'https://kody.codes',
			name: '  ',
		}),
	).toThrow(/secret name is required/i)
})
