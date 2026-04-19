import { expect, test } from 'vitest'
import {
	formatEntityDetailMarkdown,
	formatSearchMarkdown,
	parseEntityRef,
	toSlimStructuredMatches,
} from './search-format.ts'

test('parseEntityRef accepts value and connector entity types', () => {
	expect(parseEntityRef('user:preferred_repo:value')).toEqual({
		id: 'user:preferred_repo',
		type: 'value',
	})
	expect(parseEntityRef('github:connector')).toEqual({
		id: 'github',
		type: 'connector',
	})
})

test('search markdown surfaces entity identifiers and match-specific details', () => {
	const markdown = formatSearchMarkdown({
		baseUrl: 'http://localhost',
		warnings: [],
		matches: [
			{
				type: 'value',
				valueId: 'user:preferred_repo',
				name: 'preferred_repo',
				scope: 'user',
				description: 'Preferred repository owner/name.',
				value: 'kentcdodds/kody',
				appId: null,
				updatedAt: '2026-03-20T00:00:00.000Z',
				ttlMs: null,
				usage: 'Read with value_get: {"name":"preferred_repo","scope":"user"}.',
				fusedScore: 1,
			},
			{
				type: 'connector',
				connectorName: 'github',
				title: 'github',
				description: 'GitHub OAuth connector config',
				flow: 'confidential',
				tokenUrl: 'https://github.com/login/oauth/access_token',
				apiBaseUrl: 'https://api.github.com',
				clientIdValueName: 'github_client_id',
				clientSecretSecretName: 'github_client_secret',
				accessTokenSecretName: 'github_access_token',
				refreshTokenSecretName: 'github_refresh_token',
				requiredHosts: ['api.github.com'],
				usage: 'Read with connector_get: {"name":"github"}.',
				fusedScore: 0.9,
			},
		],
	})

	expect(markdown).toContain('**Entity:** `user:preferred_repo:value`')
	expect(markdown).toContain('Preferred repository owner/name.')
	expect(markdown).toContain('**Flow:** `confidential`')
	expect(markdown).toContain('**API base URL:** `https://api.github.com`')
})

test('slim structured matches include value and connector fields', () => {
	const matches = toSlimStructuredMatches({
		baseUrl: 'http://localhost',
		matches: [
			{
				type: 'value',
				valueId: 'user:preferred_repo',
				name: 'preferred_repo',
				scope: 'user',
				description: 'Preferred repository owner/name.',
				value: 'kentcdodds/kody',
				appId: null,
				updatedAt: '2026-03-20T00:00:00.000Z',
				ttlMs: null,
				usage: 'Read with value_get: {"name":"preferred_repo","scope":"user"}.',
				fusedScore: 1,
			},
			{
				type: 'connector',
				connectorName: 'github',
				title: 'github',
				description: 'GitHub OAuth connector config',
				flow: 'confidential',
				tokenUrl: 'https://github.com/login/oauth/access_token',
				apiBaseUrl: 'https://api.github.com',
				clientIdValueName: 'github_client_id',
				clientSecretSecretName: 'github_client_secret',
				accessTokenSecretName: 'github_access_token',
				refreshTokenSecretName: 'github_refresh_token',
				requiredHosts: ['api.github.com'],
				usage: 'Read with connector_get: {"name":"github"}.',
				fusedScore: 0.9,
			},
		],
	})

	expect(matches).toEqual([
		{
			type: 'value',
			id: 'user:preferred_repo',
			name: 'preferred_repo',
			title: 'preferred_repo',
			description: 'Preferred repository owner/name.',
			usage: 'codemode.value_get({ name: "preferred_repo", scope: "user" })',
			scope: 'user',
			appId: null,
		},
		{
			type: 'connector',
			id: 'github',
			name: 'github',
			title: 'github',
			description: 'GitHub OAuth connector config',
			usage: 'codemode.connector_get({ name: "github" })',
			flow: 'confidential',
			apiBaseUrl: 'https://api.github.com',
			requiredHosts: ['api.github.com'],
		},
	])
})

test('entity detail formatting supports value and connector entities', () => {
	const valueDetail = formatEntityDetailMarkdown({
		type: 'value',
		id: 'user:preferred_repo',
		title: 'preferred_repo',
		description: 'Preferred repository owner/name.',
		row: {
			name: 'preferred_repo',
			scope: 'user',
			value: 'kentcdodds/kody',
			description: 'Preferred repository owner/name.',
			appId: null,
			createdAt: '2026-03-20T00:00:00.000Z',
			updatedAt: '2026-03-20T00:00:00.000Z',
			ttlMs: null,
		},
	})
	expect(valueDetail.markdown).toContain('codemode.value_get')
	expect(valueDetail.markdown).toContain('kentcdodds/kody')
	expect(valueDetail.structured).toMatchObject({
		type: 'value',
		scope: 'user',
		value: 'kentcdodds/kody',
	})

	const connectorDetail = formatEntityDetailMarkdown({
		type: 'connector',
		id: 'github',
		title: 'github',
		description: 'GitHub OAuth connector config',
		row: {
			name: '_connector:github',
			scope: 'user',
			value: '{}',
			description: 'GitHub OAuth connector config',
			appId: null,
			createdAt: '2026-03-20T00:00:00.000Z',
			updatedAt: '2026-03-20T00:00:00.000Z',
			ttlMs: null,
		},
		config: {
			name: 'github',
			tokenUrl: 'https://github.com/login/oauth/access_token',
			apiBaseUrl: 'https://api.github.com',
			flow: 'confidential',
			clientIdValueName: 'github_client_id',
			clientSecretSecretName: 'github_client_secret',
			accessTokenSecretName: 'github_access_token',
			refreshTokenSecretName: 'github_refresh_token',
			requiredHosts: ['api.github.com'],
		},
	})
	expect(connectorDetail.markdown).toContain('codemode.connector_get')
	expect(connectorDetail.markdown).toContain('api.github.com')
	expect(connectorDetail.structured).toMatchObject({
		type: 'connector',
		flow: 'confidential',
		apiBaseUrl: 'https://api.github.com',
		requiredHosts: ['api.github.com'],
	})
})

test('entity detail formatting includes saved app backend metadata', () => {
	const appDetail = formatEntityDetailMarkdown({
		type: 'app',
		id: 'app-123',
		title: 'Facet counter',
		description: 'Saved app with a facet backend',
		hostedUrl: 'http://localhost/ui/app-123',
		row: {
			id: 'app-123',
			user_id: 'user-123',
			title: 'Facet counter',
			description: 'Saved app with a facet backend',
			sourceId: 'source-app-123',
			hasServerCode: true,
			parameters: null,
			hidden: false,
			created_at: '2026-03-20T00:00:00.000Z',
			updated_at: '2026-03-20T00:00:00.000Z',
		},
	})
	expect(appDetail.markdown).toContain('Has backend: yes')
	expect(appDetail.structured).toMatchObject({
		type: 'app',
		hasServerCode: true,
		hostedUrl: 'http://localhost/ui/app-123',
	})
})
