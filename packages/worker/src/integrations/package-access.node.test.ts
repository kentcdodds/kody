import { expect, test } from 'vitest'
import { buildIntegrationUsageUrl } from './package-access.ts'

test('buildIntegrationUsageUrl keeps Remix %2E encoding for dotted names', () => {
	expect(
		buildIntegrationUsageUrl({
			baseUrl: 'https://example.com',
			name: 'google',
		}),
	).toBe('https://example.com/account/integrations/google')
	expect(
		buildIntegrationUsageUrl({
			baseUrl: 'https://example.com',
			name: 'google.personal',
		}),
	).toBe('https://example.com/account/integrations/google%2Epersonal')
})
