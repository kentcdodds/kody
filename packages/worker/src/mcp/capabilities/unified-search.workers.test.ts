import { expect, test } from 'vitest'
import { searchUnified } from './unified-search.ts'
import { type CapabilitySpec } from '#mcp/capabilities/types.ts'
import { type McpSkillRow } from '#mcp/skills/mcp-skills-types.ts'
import { type UiArtifactRow } from '#mcp/ui-artifacts-types.ts'
import { type ValueMetadata } from '#mcp/values/types.ts'

function createSkillRow(skillId: string): McpSkillRow {
	return {
		id: skillId,
		user_id: 'user-123',
		name: `skill-${skillId}`,
		title: 'Cursor agents with open PRs',
		description: 'Fetch Cursor agents with open GitHub PRs.',
		collection_name: 'GitHub Workflows',
		collection_slug: 'github-workflows',
		keywords: JSON.stringify(['cursor', 'agents', 'github', 'pr']),
		code: 'async () => ({ ok: true })',
		search_text: 'cursor agents open pull requests',
		uses_capabilities: null,
		parameters: null,
		inferred_capabilities: JSON.stringify([]),
		inference_partial: 0,
		read_only: 1,
		idempotent: 1,
		destructive: 0,
		created_at: '2026-03-20T00:00:00.000Z',
		updated_at: '2026-03-20T00:00:00.000Z',
	}
}

function createUiArtifactRow(appId: string): UiArtifactRow {
	return {
		id: appId,
		user_id: 'user-123',
		title: 'Cloudflare deploy app',
		description: 'Saved UI for deploying a Worker',
		code: '<main>Deploy</main>',
		runtime: 'html',
		parameters: JSON.stringify([
			{
				name: 'workerName',
				description: 'Worker name to deploy.',
				type: 'string',
				required: true,
			},
		]),
		hidden: false,
		created_at: '2026-03-20T00:00:00.000Z',
		updated_at: '2026-03-20T00:00:00.000Z',
	}
}

function createValueRow(
	name: string,
	overrides: Partial<ValueMetadata> = {},
): ValueMetadata {
	return {
		name,
		scope: 'user',
		value: 'stored-value',
		description: 'Stored config value',
		appId: null,
		createdAt: '2026-03-20T00:00:00.000Z',
		updatedAt: '2026-03-20T00:00:00.000Z',
		ttlMs: null,
		...overrides,
	}
}

test('skill search hits include usage hints', async () => {
	const env = { SENTRY_ENVIRONMENT: 'test' } as Env
	const skillRow = createSkillRow('skill-usage-hint')
	const specs = {} as Record<string, CapabilitySpec>

	const result = await searchUnified({
		env,
		baseUrl: 'http://localhost',
		query: 'open pull requests for cursor agents',
		limit: 5,
		specs,
		userId: 'user-123',
		skillRows: [skillRow],
		uiArtifactRows: [],
		userSecretRows: [],
		userValueRows: [],
		appSecretsByAppId: new Map(),
	})

	const skill = result.matches.find((match) => match.type === 'skill')
	if (!skill || skill.type !== 'skill') {
		throw new Error('Expected a skill match in results.')
	}

	expect(skill.usage).toContain('meta_run_skill')
	expect(skill.usage).toContain(skillRow.name)
	expect(skill.usage).toContain('"params"')
	expect(skill.collection).toBe('GitHub Workflows')
	expect(skill.collectionSlug).toBe('github-workflows')
	expect(skill.skillName).toBe(skillRow.name)
})

test('skill collection filter narrows saved skill matches', async () => {
	const env = { SENTRY_ENVIRONMENT: 'test' } as Env
	const specs = {} as Record<string, CapabilitySpec>
	const matchingRow = createSkillRow('skill-matching-collection')
	const otherRow = {
		...createSkillRow('skill-other-collection'),
		title: 'Cloudflare deploy helper',
		description: 'Deploy a Worker to Cloudflare.',
		collection_name: 'Cloudflare Ops',
		collection_slug: 'cloudflare-ops',
		keywords: JSON.stringify(['cloudflare', 'deploy', 'worker']),
		search_text: 'deploy cloudflare worker',
	}

	const result = await searchUnified({
		env,
		baseUrl: 'http://localhost',
		query: 'github pull requests',
		limit: 5,
		specs,
		userId: 'user-123',
		skillCollectionSlug: 'github-workflows',
		skillRows: [matchingRow, otherRow],
		uiArtifactRows: [],
		userSecretRows: [],
		userValueRows: [],
		appSecretsByAppId: new Map(),
	})

	const matches = result.matches.filter((match) => match.type === 'skill')
	expect(matches).toHaveLength(1)
	const skill = matches[0]
	if (!skill || skill.type !== 'skill') {
		throw new Error('Expected a skill match in results.')
	}
	expect(skill.skillName).toBe(matchingRow.name)
	expect(skill.collection).toBe('GitHub Workflows')
})

test('skill name and description matches survive cross-entity ranking', async () => {
	const env = { SENTRY_ENVIRONMENT: 'test' } as Env
	const specs = {
		launch_agent: {
			name: 'launch_agent',
			domain: 'coding',
			description: 'Launch an agent for generic coding work.',
			keywords: ['launch', 'agent', 'coding'],
			readOnly: true,
			idempotent: true,
			destructive: false,
			inputFields: ['task'],
			requiredInputFields: ['task'],
			outputFields: ['agentId'],
			inputSchema: {},
		},
		cursor_docs: {
			name: 'cursor_docs',
			domain: 'coding',
			description: 'Look up Cursor product documentation.',
			keywords: ['cursor', 'docs'],
			readOnly: true,
			idempotent: true,
			destructive: false,
			inputFields: ['query'],
			requiredInputFields: ['query'],
			outputFields: ['results'],
			inputSchema: {},
		},
		cursor_agent_status: {
			name: 'cursor_agent_status',
			domain: 'coding',
			description: 'Inspect the status of an existing Cursor agent.',
			keywords: ['cursor', 'agent', 'status'],
			readOnly: true,
			idempotent: true,
			destructive: false,
			inputFields: ['agentId'],
			requiredInputFields: ['agentId'],
			outputFields: ['status'],
			inputSchema: {},
		},
	} satisfies Record<string, CapabilitySpec>
	const skillRow: McpSkillRow = {
		...createSkillRow('launch-cursor-cloud-agent'),
		name: 'launch-cursor-cloud-agent',
		title: 'Launch Cursor Cloud Agent',
		description: 'Launch a Cursor Cloud Agent for an autonomous coding task.',
		collection_name: 'Cursor',
		collection_slug: 'cursor',
		keywords: JSON.stringify(['cursor', 'cloud', 'agent', 'launch']),
		search_text: 'launch cursor cloud agent autonomous coding task',
	}

	const result = await searchUnified({
		env,
		baseUrl: 'http://localhost',
		query: 'launch Cursor Cloud agent',
		limit: 5,
		specs,
		userId: 'user-123',
		skillRows: [skillRow],
		uiArtifactRows: [],
		userSecretRows: [],
		userValueRows: [],
		appSecretsByAppId: new Map(),
	})

	expect(result.matches[0]).toMatchObject({
		type: 'skill',
		skillName: 'launch-cursor-cloud-agent',
		title: 'Launch Cursor Cloud Agent',
	})
})

test('search can return standalone user secrets and nest app secrets on apps', async () => {
	const env = { SENTRY_ENVIRONMENT: 'test' } as Env
	const specs = {} as Record<string, CapabilitySpec>
	const appRow = createUiArtifactRow('app-123')

	const result = await searchUnified({
		env,
		baseUrl: 'http://localhost',
		query: 'cloudflare deploy token',
		limit: 5,
		specs,
		userId: 'user-123',
		skillRows: [],
		uiArtifactRows: [appRow],
		userSecretRows: [
			{
				name: 'cloudflareToken',
				scope: 'user',
				description: 'Reusable Cloudflare API token',
				appId: null,
				updatedAt: '2026-03-20T00:00:00.000Z',
			},
		],
		userValueRows: [],
		appSecretsByAppId: new Map([
			[
				appRow.id,
				[
					{
						name: 'deploySecret',
						scope: 'app',
						description: 'Worker secret for this app',
						appId: appRow.id,
						updatedAt: '2026-03-20T00:00:00.000Z',
					},
				],
			],
		]),
	})

	const secret = result.matches.find((match) => match.type === 'secret')
	if (!secret || secret.type !== 'secret') {
		throw new Error('Expected a standalone user secret result.')
	}
	expect(secret.scope).toBe('user')
	expect(secret.name).toBe('cloudflareToken')

	const app = result.matches.find((match) => match.type === 'app')
	if (!app || app.type !== 'app') {
		throw new Error('Expected an app result.')
	}
	expect(app.availableSecrets).toEqual([
		{
			name: 'deploySecret',
			description: 'Worker secret for this app',
		},
	])
	expect(app.usage).toContain('"params"')
	expect(app.hostedUrl).toBe('http://localhost/ui/app-123')
})

test('search returns value and connector entities as first-class matches', async () => {
	const env = { SENTRY_ENVIRONMENT: 'test' } as Env
	const specs = {} as Record<string, CapabilitySpec>
	const valueRow = createValueRow('github_repo', {
		value: 'kentcdodds/kody',
		description: 'Default GitHub repository',
	})
	const connectorRow = createValueRow('_connector:github', {
		value: JSON.stringify({
			name: 'github',
			tokenUrl: 'https://github.com/login/oauth/access_token',
			apiBaseUrl: 'https://api.github.com',
			flow: 'confidential',
			clientIdValueName: 'github_client_id',
			clientSecretSecretName: 'github_client_secret',
			accessTokenSecretName: 'github_access_token',
			refreshTokenSecretName: 'github_refresh_token',
			requiredHosts: ['api.github.com'],
		}),
		description: 'GitHub OAuth connector config',
	})

	const result = await searchUnified({
		env,
		baseUrl: 'http://localhost',
		query: 'github connector config repo value',
		limit: 10,
		specs,
		userId: 'user-123',
		skillRows: [],
		uiArtifactRows: [],
		userSecretRows: [],
		userValueRows: [valueRow, connectorRow],
		appSecretsByAppId: new Map(),
	})

	const connector = result.matches.find((match) => match.type === 'connector')
	if (!connector || connector.type !== 'connector') {
		throw new Error('Expected a connector result.')
	}
	expect(connector.connectorName).toBe('github')
	expect(connector.apiBaseUrl).toBe('https://api.github.com')
	expect(connector.requiredHosts).toEqual(['api.github.com'])
	expect(connector.usage).toContain('connector_get')

	const value = result.matches.find((match) => match.type === 'value')
	if (!value || value.type !== 'value') {
		throw new Error('Expected a value result.')
	}
	expect(value.name).toBe('github_repo')
	expect(value.scope).toBe('user')
	expect(value.value).toBe('kentcdodds/kody')
	expect(value.usage).toContain('value_get')
})

test('exact value and connector phrase matches win cross-entity lexical tiebreaks', async () => {
	const env = { SENTRY_ENVIRONMENT: 'test' } as Env
	const specs = {
		github_helper: {
			name: 'github_helper',
			domain: 'coding',
			description: 'Connector config for GitHub automation.',
			keywords: ['github', 'connector', 'config'],
			readOnly: true,
			idempotent: true,
			destructive: false,
			inputFields: ['query'],
			requiredInputFields: ['query'],
			outputFields: ['result'],
			inputSchema: {},
		},
	} satisfies Record<string, CapabilitySpec>
	const valueRow = createValueRow('github_connector', {
		description: 'Stored user setting',
		value: 'enabled',
	})

	const valueResult = await searchUnified({
		env,
		baseUrl: 'http://localhost',
		query: 'github connector',
		limit: 5,
		specs,
		userId: 'user-123',
		skillRows: [],
		uiArtifactRows: [],
		userSecretRows: [
			{
				name: 'github-secret',
				scope: 'user',
				description: 'Connector token for GitHub',
				appId: null,
				updatedAt: '2026-03-20T00:00:00.000Z',
			},
		],
		userValueRows: [valueRow],
		appSecretsByAppId: new Map(),
	})

	expect(valueResult.matches[0]).toMatchObject({
		type: 'value',
		name: 'github_connector',
	})

	const connectorRow = createValueRow('_connector:github-connector', {
		value: JSON.stringify({
			name: 'github-connector',
			tokenUrl: 'https://github.com/login/oauth/access_token',
			apiBaseUrl: 'https://api.github.com',
			flow: 'confidential',
			clientIdValueName: 'github_client_id',
			clientSecretSecretName: 'github_client_secret',
			accessTokenSecretName: 'github_access_token',
			refreshTokenSecretName: 'github_refresh_token',
			requiredHosts: ['api.github.com'],
		}),
		description: 'GitHub connector config',
	})

	const connectorResult = await searchUnified({
		env,
		baseUrl: 'http://localhost',
		query: 'github connector config',
		limit: 5,
		specs,
		userId: 'user-123',
		skillRows: [],
		uiArtifactRows: [],
		userSecretRows: [],
		userValueRows: [connectorRow],
		appSecretsByAppId: new Map(),
	})

	expect(connectorResult.matches[0]).toMatchObject({
		type: 'connector',
		connectorName: 'github-connector',
	})
})

test('search skips connector rows whose stored id disagrees with config.name', async () => {
	const env = { SENTRY_ENVIRONMENT: 'test' } as Env
	const specs = {} as Record<string, CapabilitySpec>
	const mismatchedConnectorRow = createValueRow('_connector:github', {
		value: JSON.stringify({
			name: 'github-enterprise',
			tokenUrl: 'https://github.com/login/oauth/access_token',
			apiBaseUrl: 'https://api.github.com',
			flow: 'confidential',
			clientIdValueName: 'github_client_id',
			clientSecretSecretName: 'github_client_secret',
			accessTokenSecretName: 'github_access_token',
			refreshTokenSecretName: 'github_refresh_token',
			requiredHosts: ['api.github.com'],
		}),
		description: 'Mismatched connector config',
	})

	const result = await searchUnified({
		env,
		baseUrl: 'http://localhost',
		query: 'github connector config',
		limit: 10,
		specs,
		userId: 'user-123',
		skillRows: [],
		uiArtifactRows: [],
		userSecretRows: [],
		userValueRows: [mismatchedConnectorRow],
		appSecretsByAppId: new Map(),
	})

	expect(result.matches.some((match) => match.type === 'connector')).toBe(false)
})
