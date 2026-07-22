import { expect, test } from 'vitest'
import { buildIntegrationValueName } from '#mcp/capabilities/integrations/integration-shared.ts'

import {
	entityDetailTypes,
	searchableEntityTypes,
	searchEntityPlugins,
} from './search-entity-registry.ts'
import { buildSearchableEntityDescriptors } from './search-descriptors.ts'
import { type PackageSearchRow } from './search-types.ts'

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

test('search entity registry preserves candidate order and entity-backed types', () => {
	expect(searchableEntityTypes).toEqual([
		'capability',
		'package',
		'value',
		'integration',
		'secret',
		'retriever_result',
		'domain',
	])
	expect(entityDetailTypes).toEqual([
		'capability',
		'package',
		'value',
		'integration',
		'secret',
	])
	expect(
		searchEntityPlugins.map((plugin) => ({
			type: plugin.type,
			hasCandidates: 'buildCandidates' in plugin,
			hasSlimFormatter: 'formatSlimMatch' in plugin,
			hasDetailFormatter: 'formatEntityDetail' in plugin,
		})),
	).toEqual([
		{
			type: 'capability',
			hasCandidates: true,
			hasSlimFormatter: true,
			hasDetailFormatter: true,
		},
		{
			type: 'package',
			hasCandidates: true,
			hasSlimFormatter: true,
			hasDetailFormatter: true,
		},
		{
			type: 'value',
			hasCandidates: true,
			hasSlimFormatter: true,
			hasDetailFormatter: true,
		},
		{
			type: 'integration',
			hasCandidates: true,
			hasSlimFormatter: true,
			hasDetailFormatter: true,
		},
		{
			type: 'secret',
			hasCandidates: true,
			hasSlimFormatter: true,
			hasDetailFormatter: true,
		},
		{
			type: 'retriever_result',
			hasCandidates: true,
			hasSlimFormatter: true,
			hasDetailFormatter: false,
		},
		{
			type: 'domain',
			hasCandidates: false,
			hasSlimFormatter: true,
			hasDetailFormatter: false,
		},
	])
})

test('descriptor seam follows registry order across entity modules', () => {
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
})
