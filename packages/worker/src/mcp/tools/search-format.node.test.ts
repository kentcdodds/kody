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

test('search markdown and entity detail formatting preserve structured behavior', () => {
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

	expect(markdown).toMatch(/^# Search results/)
	expect(markdown).toContain('## Value')
	expect(markdown).toContain('## Connector')
	expect(markdown).toContain('user:preferred_repo:value')
	expect(markdown).toContain('https://api.github.com')

	expect(toSlimStructuredMatches({
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
	})).toEqual([
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
	expect(connectorDetail.structured).toMatchObject({
		type: 'connector',
		flow: 'confidential',
		apiBaseUrl: 'https://api.github.com',
		requiredHosts: ['api.github.com'],
	})
})

test('entity detail formatting includes saved app backend metadata in structured output', () => {
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
			hasClient: true,
			hasServerCode: true,
			parameters: null,
			hidden: false,
			taskNames: ['refresh'],
			jobNames: ['nightly-refresh'],
			scheduleSummaries: ['Runs every 1h'],
			created_at: '2026-03-20T00:00:00.000Z',
			updated_at: '2026-03-20T00:00:00.000Z',
		},
	})
	expect(appDetail.structured).toMatchObject({
		type: 'app',
		hasClient: true,
		hasServerCode: true,
		hostedUrl: 'http://localhost/ui/app-123',
		taskNames: ['refresh'],
		jobNames: ['nightly-refresh'],
	})
})
