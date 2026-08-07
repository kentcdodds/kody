import { expect, test } from 'vitest'
import { type JoinedIntegration } from '#worker/integrations/types.ts'

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
			webhooks: [],
		},
		readmeSnippet: null,
	}
}

function createJoinedIntegration(input: {
	userId?: string
	name: string
	description?: string
	scopes?: Array<string>
	requiredHosts?: Array<string>
	appSlug?: string
}): JoinedIntegration {
	const userId = input.userId ?? 'user-1'
	const appSlug = input.appSlug ?? input.name
	const now = '2026-01-01T00:00:00.000Z'
	return {
		lane: 'user',
		app: {
			userId,
			slug: appSlug,
			provider: appSlug.split('-')[0] ?? appSlug,
			label: null,
			clientId: `${input.name}_client_id`,
			clientSecretSecretName: `${input.name}_client_secret`,
			tokenUrl: 'https://github.com/login/oauth/access_token',
			authorizeUrl: 'https://github.com/login/oauth/authorize',
			apiBaseUrl: 'https://api.github.com',
			flow: 'confidential',
			usePkce: null,
			tokenExchangeStyle: null,
			scopeSeparator: null,
			extraAuthorizeParams: {},
			createdAt: now,
			updatedAt: now,
		},
		connection: {
			userId,
			name: input.name,
			appSlug,
			platformAppSlug: null,
			accountLabel: null,
			description: input.description ?? `${input.name} integration`,
			scopes: input.scopes ?? [],
			requiredHosts: input.requiredHosts ?? ['api.github.com'],
			accessTokenSecretName: `${input.name}_access_token`,
			refreshTokenSecretName: null,
			connectedAt: null,
			tokenRefreshedAt: null,
			createdAt: now,
			updatedAt: now,
		},
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
			],
			userIntegrationRows: [
				createJoinedIntegration({
					name: 'github',
					description: 'GitHub integration',
				}),
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

	const userIntegrationRows = [
		createJoinedIntegration({
			name: 'github',
			description: 'GitHub integration',
		}),
	] satisfies OptionalSearchRowsResult['userIntegrationRows']
	const userValueRows = Array.from({ length: 8 }, (_, index) => ({
		userId: 'user-1',
		name: `github_value_${index}`,
		value: `github value ${index}`,
		description: 'GitHub preference',
		scope: 'user' as const,
		appId: null,
		ttlMs: null,
		createdAt: '2026-01-01T00:00:00.000Z',
		updatedAt: '2026-01-01T00:00:00.000Z',
	})) satisfies OptionalSearchRowsResult['userValueRows']
	const affinityDescriptors = buildSearchableEntityDescriptors({
		registry: { capabilitySpecs: {} } as never,
		optionalRows: {
			packageRows: [],
			userSecretRows: [],
			userValueRows,
			userIntegrationRows,
		},
	})

	expect(affinityDescriptors.map((descriptor) => descriptor.type)).toEqual([
		'value',
		'value',
		'value',
		'value',
		'value',
		'value',
		'value',
		'value',
		'integration',
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

test('value search descriptors include underscore-prefixed ordinary values', () => {
	const descriptors = buildSearchableEntityDescriptors({
		registry: { capabilitySpecs: {} } as never,
		optionalRows: {
			packageRows: [],
			userSecretRows: [],
			userValueRows: [
				{
					userId: 'user-1',
					name: '_scratch:widgets',
					value: '{"provider":"widgets"}',
					description: 'Scratch widgets config',
					scope: 'user',
					appId: null,
					ttlMs: null,
					createdAt: '2026-01-01T00:00:00.000Z',
					updatedAt: '2026-01-01T00:00:00.000Z',
				},
				{
					userId: 'user-1',
					name: 'preferred_repo',
					value: 'kentcdodds/kody',
					description: 'Preferred repo',
					scope: 'user',
					appId: null,
					ttlMs: null,
					createdAt: '2026-01-01T00:00:00.000Z',
					updatedAt: '2026-01-01T00:00:00.000Z',
				},
			],
			userIntegrationRows: [],
		},
	})

	expect(descriptors.map((descriptor) => descriptor.id).sort()).toEqual([
		'user:_scratch%3Awidgets',
		'user:preferred_repo',
	])
})
