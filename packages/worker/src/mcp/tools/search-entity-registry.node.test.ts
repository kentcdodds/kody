import { expect, test } from 'vitest'
import { buildIntegrationValueName } from '#mcp/capabilities/integrations/integration-shared.ts'

import { searchEntityPlugins } from './search-entity-registry.ts'
import { buildSearchableEntityDescriptors } from './search-descriptors.ts'
import {
	type OptionalSearchRowsResult,
	type PackageSearchRow,
} from './search-types.ts'
import { understandSearchQuery } from './understand-search-query.ts'

function createPackageRow(): PackageSearchRow {
	return {
		record: {
			id: 'pkg-1',
			userId: 'user-1',
			name: '@user/weather',
			kodyId: 'weather',
			description: 'Weather package',
			tags: ['weather'],
			searchText: null,
			sourceId: 'source-1',
			hasApp: false,
			hidden: false,
			isPrivate: false,
			createdAt: '2026-01-01T00:00:00.000Z',
			updatedAt: '2026-01-01T00:00:00.000Z',
		},
		projection: {
			name: '@user/weather',
			kodyId: 'weather',
			description: 'Weather package',
			tags: ['weather'],
			searchText: null,
			hasApp: false,
			hidden: false,
			isPrivate: false,
			appEntry: null,
			exports: [],
			jobs: [],
			services: [],
			subscriptions: [],
			retrievers: [],
		},
		readmeSnippet: null,
	}
}

test('descriptor seam follows registry order and preserves value-backed affinity', () => {
	expect(searchEntityPlugins.map((plugin) => plugin.type)).toEqual([
		'capability',
		'package',
		'value',
		'integration',
		'secret',
		'retriever_result',
		'domain',
	])

	const descriptors = buildSearchableEntityDescriptors({
		registry: {
			capabilitySpecs: {
				weather_search: {
					name: 'weather_search',
					domain: 'home',
					description: 'Search weather',
					keywords: ['forecast'],
					inputFields: ['city'],
					outputFields: ['forecast'],
				},
			},
		} as never,
		optionalRows: {
			packageRows: [createPackageRow()],
			userValueRows: [
				{
					userId: 'user-1',
					name: 'preferred_city',
					value: 'Portland',
					description: 'Preferred city',
					scope: 'user',
					appId: null,
					ttlMs: null,
					createdAt: '2026-01-01T00:00:00.000Z',
					updatedAt: '2026-01-01T00:00:00.000Z',
				},
				{
					userId: 'user-1',
					name: buildIntegrationValueName('GitHub'),
					value: JSON.stringify({
						name: 'github',
						tokenUrl: 'https://github.com/login/oauth/access_token',
						apiBaseUrl: 'https://api.github.com',
						flow: 'confidential',
						clientIdValueName: 'github_client_id',
						clientSecretSecretName: 'github_client_secret',
						accessTokenSecretName: 'github_access_token',
					}),
					description: 'GitHub integration',
					scope: 'user',
					appId: null,
					ttlMs: null,
					createdAt: '2026-01-01T00:00:00.000Z',
					updatedAt: '2026-01-01T00:00:00.000Z',
				},
			],
			userSecretRows: [
				{
					name: 'weather_api_key',
					description: 'Weather API key',
					scope: 'user',
					updatedAt: '2026-01-01T00:00:00.000Z',
				},
			],
		},
	})

	expect(descriptors.map((descriptor) => descriptor.type)).toEqual([
		'capability',
		'package',
		'value',
		'integration',
		'secret',
	])
	expect(descriptors.map((descriptor) => descriptor.id)).toEqual([
		'weather_search',
		'weather',
		'user:preferred_city',
		'github',
		'weather_api_key',
	])

	const userValueRows = [
		{
			userId: 'user-1',
			name: buildIntegrationValueName('github'),
			value: JSON.stringify({
				name: 'github',
				tokenUrl: 'https://github.com/login/oauth/access_token',
				apiBaseUrl: 'https://api.github.com',
				flow: 'confidential',
				clientIdValueName: 'github_client_id',
				clientSecretSecretName: 'github_client_secret',
				accessTokenSecretName: 'github_access_token',
			}),
			description: 'GitHub integration',
			scope: 'user' as const,
			appId: null,
			ttlMs: null,
			createdAt: '2026-01-01T00:00:00.000Z',
			updatedAt: '2026-01-01T00:00:00.000Z',
		},
		...Array.from({ length: 8 }, (_, index) => ({
			userId: 'user-1',
			name: `github_value_${index}`,
			value: `github value ${index}`,
			description: 'GitHub preference',
			scope: 'user' as const,
			appId: null,
			ttlMs: null,
			createdAt: '2026-01-01T00:00:00.000Z',
			updatedAt: '2026-01-01T00:00:00.000Z',
		})),
	] satisfies OptionalSearchRowsResult['userValueRows']
	const affinityDescriptors = buildSearchableEntityDescriptors({
		registry: { capabilitySpecs: {} } as never,
		optionalRows: {
			packageRows: [],
			userSecretRows: [],
			userValueRows,
		},
	})

	expect(affinityDescriptors.map((descriptor) => descriptor.type)).toEqual([
		'integration',
		...Array.from({ length: 8 }, () => 'value'),
	])

	const intent = understandSearchQuery({
		query: 'github',
		entities: affinityDescriptors,
	})
	expect(intent.entities).toHaveLength(8)
	expect(intent.entities[0]).toMatchObject({
		type: 'integration',
		id: 'github',
	})
})
