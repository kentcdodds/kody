import { expect, test } from 'vitest'
import { buildIntegrationUsageUrl } from './package-access.ts'

test('buildIntegrationUsageUrl keeps Remix %2E encoding for dotted names', () => {
	expect(
		buildIntegrationUsageUrl({
			baseUrl: 'https://example.com',
			orgSlug: 'ada',
			name: 'google',
		}),
	).toBe('https://example.com/@ada/-/integrations/google')
	expect(
		buildIntegrationUsageUrl({
			baseUrl: 'https://example.com',
			orgSlug: 'ada',
			name: 'google.personal',
		}),
	).toBe('https://example.com/@ada/-/integrations/google%2Epersonal')
})
