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
		guidance:
			'Inspect connector detail with `search({ entity: "github:connector" })` next.',
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
	expect(markdown).toContain('**Entity:** `user:preferred_repo:value`')
	expect(markdown).toContain('**Entity:** `github:connector`')
	expect(markdown).toContain(
		'**Read:** `codemode.connector_get({ name: "github" })`',
	)
	expect(markdown).toContain('**Token URL:** `https://github.com/login/oauth/access_token`')
	expect(markdown).toContain('**Client ID value:** `github_client_id`')
	expect(markdown).toContain('`user:preferred_repo:value`')
	expect(markdown).toContain('`https://api.github.com`')
	expect(markdown).toContain('## Recommended next step')
	expect(markdown).toContain('`search({ entity: "github:connector" })`')

	expect(
		toSlimStructuredMatches({
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
					usage:
						'Read with value_get: {"name":"preferred_repo","scope":"user"}.',
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
		}),
	).toEqual([
		{
			type: 'value',
			id: 'user:preferred_repo',
			entityRef: 'user:preferred_repo:value',
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
			entityRef: 'github:connector',
			name: 'github',
			title: 'github',
			description: 'GitHub OAuth connector config',
			usage: 'codemode.connector_get({ name: "github" })',
			flow: 'confidential',
			tokenUrl: 'https://github.com/login/oauth/access_token',
			apiBaseUrl: 'https://api.github.com',
			clientIdValueName: 'github_client_id',
			clientSecretSecretName: 'github_client_secret',
			accessTokenSecretName: 'github_access_token',
			refreshTokenSecretName: 'github_refresh_token',
			requiredHosts: ['api.github.com'],
			nextStep:
				'Inspect connector detail with search({ entity: "github:connector" }) and then run a minimal authenticated execute smoke test before building or calling integration-backed code.',
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
		entityRef: 'user:preferred_repo:value',
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
		entityRef: 'github:connector',
		flow: 'confidential',
		tokenUrl: 'https://github.com/login/oauth/access_token',
		apiBaseUrl: 'https://api.github.com',
		clientIdValueName: 'github_client_id',
		clientSecretSecretName: 'github_client_secret',
		accessTokenSecretName: 'github_access_token',
		refreshTokenSecretName: 'github_refresh_token',
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
			'src/app.d.ts':
				'export default function fetch(request: Request): Promise<Response>\n',
		},
	})
	expect(packageDetail.markdown).toContain(
		'- Open: `open_generated_ui({ kody_id: "observed-package" })`',
	)
	expect(packageDetail.structured).toMatchObject({
		type: 'package',
		entityRef: 'observed-package:package',
		usage: 'open_generated_ui({ kody_id: "observed-package" })',
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

test('search markdown and slim structured matches surface package entity refs and app hints', () => {
	const markdown = formatSearchMarkdown({
		baseUrl: 'http://localhost',
		warnings: [],
		matches: [
			{
				type: 'package',
				packageId: 'package-123',
				kodyId: 'spotify-playback',
				name: '@kody/spotify-playback',
				title: '@kody/spotify-playback',
				description: 'Saved package for Spotify playback controls.',
				tags: ['spotify', 'playback'],
				hasApp: true,
			},
		],
	})

	expect(markdown).toContain('**Entity:** `spotify-playback:package`')
	expect(markdown).toContain('**Package ID:** `package-123`')
	expect(markdown).toContain(
		'**Open app:** `open_generated_ui({ kody_id: "spotify-playback" })`',
	)
	expect(markdown).toContain('**Import:** `import entry from "kody:@spotify-playback"`')

	expect(
		toSlimStructuredMatches({
			baseUrl: 'http://localhost',
			matches: [
				{
					type: 'package',
					packageId: 'package-123',
					kodyId: 'spotify-playback',
					name: '@kody/spotify-playback',
					title: '@kody/spotify-playback',
					description: 'Saved package for Spotify playback controls.',
					tags: ['spotify', 'playback'],
					hasApp: true,
				},
			],
		}),
	).toEqual([
		{
			type: 'package',
			id: 'spotify-playback',
			entityRef: 'spotify-playback:package',
			packageId: 'package-123',
			kodyId: 'spotify-playback',
			title: '@kody/spotify-playback',
			description: 'Saved package for Spotify playback controls.',
			usage: 'open_generated_ui({ kody_id: "spotify-playback" })',
			rootImportUsage: 'import entry from "kody:@spotify-playback"',
			openGeneratedUiUsage:
				'open_generated_ui({ kody_id: "spotify-playback" })',
			tags: ['spotify', 'playback'],
			hasApp: true,
			hostedUrl: 'http://localhost/packages/spotify-playback',
			nextStep:
				'Open the app with open_generated_ui({ kody_id: "spotify-playback" }) or inspect package detail with search({ entity: "spotify-playback:package" }).',
		},
	])
})
