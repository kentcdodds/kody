import { expect, test } from 'vitest'
import {
	buildIntegrationAccountUrl,
	buildIntegrationReconnectUrl,
} from './account-identity.ts'

test('account integration URLs encode Remix delimiter dots in names', () => {
	expect(
		buildIntegrationAccountUrl({
			baseUrl: 'https://example.com',
			integrationName: 'google',
		}),
	).toBe('https://example.com/account/integrations/google')
	expect(
		buildIntegrationAccountUrl({
			baseUrl: 'https://example.com',
			integrationName: 'google.personal',
		}),
	).toBe('https://example.com/account/integrations/google%2Epersonal')

	expect(
		buildIntegrationReconnectUrl({
			baseUrl: 'https://example.com',
			integrationName: 'google.personal',
		}),
	).toBe('https://example.com/connect/oauth?provider=google.personal')
})
