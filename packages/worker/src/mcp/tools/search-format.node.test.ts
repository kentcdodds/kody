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

test('entity detail formatting includes package app and export metadata', () => {
	const packageDetail = formatEntityDetailMarkdown({
		type: 'package',
		id: 'observed-package',
		title: '@kody/observed',
		description: 'Observed package with an app surface.',
		hostedUrl: 'http://localhost/packages/observed-package',
		record: {
			id: 'package-123',
			userId: 'user-123',
			name: '@kody/observed',
			kodyId: 'observed-package',
			description: 'Observed package with an app surface.',
			tags: ['observed', 'ui'],
			searchText: null,
			sourceId: 'source-package-123',
			hasApp: true,
			createdAt: '2026-03-20T00:00:00.000Z',
			updatedAt: '2026-03-20T00:00:00.000Z',
		},
		manifest: {
			name: '@kody/observed',
			exports: {
				'.': './src/index.ts',
				'./app': {
					import: './src/app.ts',
					types: './src/app.d.ts',
				},
			},
			kody: {
				id: 'observed-package',
				description: 'Observed package with an app surface.',
				tags: ['observed', 'ui'],
				app: {
					entry: './src/app.ts',
				},
				jobs: {
					nightly: {
						entry: './src/jobs/nightly.ts',
						schedule: {
							type: 'interval',
							every: '1d',
						},
					},
				},
			},
		},
		files: {
			'package.json': '{}',
			'src/app.d.ts': 'export default function fetch(request: Request): Promise<Response>\n',
		},
	})
	expect(packageDetail.structured).toMatchObject({
		type: 'package',
		hasApp: true,
		hostedUrl: 'http://localhost/packages/observed-package',
		appEntry: './src/app.ts',
	})
	expect(packageDetail.structured).toMatchObject({
		exports: [
			expect.objectContaining({
				subpath: '.',
				importSpecifier: 'kody:@observed-package',
			}),
			expect.objectContaining({
				subpath: './app',
				typesSource:
					'export default function fetch(request: Request): Promise<Response>\n',
			}),
		],
		jobs: [
			expect.objectContaining({
				name: 'nightly',
				scheduleSummary: 'Runs every 1d',
			}),
		],
	})
})
