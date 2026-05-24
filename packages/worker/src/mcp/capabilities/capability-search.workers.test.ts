import { expect, test } from 'vitest'
import {
	buildCapabilityEmbedText,
	CAPABILITY_EMBEDDING_DIMENSIONS,
	deterministicEmbedding,
	hybridSearchScore,
	lexicalScore,
	searchCapabilities,
} from './capability-search.ts'
import { type CapabilitySpec } from './types.ts'

test('capability search helpers build normalized searchable documents', () => {
	const spec = {
		name: 'deploy_worker',
		domain: 'apps',
		description: 'Deploy a Worker from saved source.',
		keywords: ['deploy', 'worker', 'wrangler'],
		readOnly: false,
		idempotent: true,
		destructive: false,
		inputFields: ['sourceId', 'environment'],
		requiredInputFields: ['sourceId'],
		outputFields: ['deploymentId'],
		inputSchema: {},
		inputTypeDefinition: 'type DeployWorkerInput = Record<string, unknown>',
	} satisfies CapabilitySpec

	const embedText = buildCapabilityEmbedText(spec)
	expect(embedText.length).toBeGreaterThan(0)
	const a = deterministicEmbedding('hello', CAPABILITY_EMBEDDING_DIMENSIONS)
	expect(a.length).toBe(CAPABILITY_EMBEDDING_DIMENSIONS)
	let sum = 0
	for (const x of a) sum += x * x
	expect(sum).toBeCloseTo(1, 5)
	const doc = 'github rest api issues pull request repository'
	expect(lexicalScore('github issues', doc)).toBeGreaterThan(
		lexicalScore('weather forecast', doc),
	)
	expect(hybridSearchScore(0, 0)).toBe(0)
	expect(hybridSearchScore(1, 1)).toBe(1)
	expect(hybridSearchScore(0.6, 0.2)).toBe(0.4)
})

test('offline detailed search returns structured capability matches without schema fields', async () => {
	const specs = {
		oauth_setup_guide: {
			name: 'oauth_setup_guide',
			domain: 'coding',
			description: 'Guide for configuring OAuth redirect URIs.',
			keywords: ['oauth', 'redirect uri', 'provider registration'],
			readOnly: true,
			idempotent: true,
			destructive: false,
			inputFields: ['guide'],
			requiredInputFields: ['guide'],
			outputFields: ['title', 'body'],
			inputSchema: {
				type: 'object',
				properties: {
					guide: { type: 'string' },
				},
				required: ['guide'],
			},
			inputTypeDefinition: 'type OAuthSetupGuideInput = {\n\tguide: string\n}',
		},
		kody_official_guide: {
			name: 'kody_official_guide',
			domain: 'coding',
			description: 'Load official Kody guides.',
			keywords: ['guide'],
			readOnly: true,
			idempotent: true,
			destructive: false,
			inputFields: ['guide'],
			requiredInputFields: ['guide'],
			outputFields: [],
			inputSchema: {
				type: 'object',
				properties: {
					guide: { type: 'string' },
				},
				required: ['guide'],
			},
			inputTypeDefinition:
				'type KodyOfficialGuideInput = {\n\tguide: string\n}',
		},
	} satisfies Record<string, CapabilitySpec>
	const env = {
		SENTRY_ENVIRONMENT: 'test',
		AI: {} as Ai,
	} as Env

	const oauthSpecs = {
		oauth_setup_guide: specs.oauth_setup_guide,
	} satisfies Record<string, CapabilitySpec>
	const oauthGuide = await searchCapabilities({
		env,
		query: 'oauth redirect uri provider registration',
		limit: 8,
		detail: true,
		specs: oauthSpecs,
	})

	expect(oauthGuide.offline).toBe(true)
	expect(oauthGuide.matches).toHaveLength(1)
	expect(oauthGuide.matches[0]).toMatchObject({
		name: 'oauth_setup_guide',
		outputFields: ['title', 'body'],
		lexicalRank: 1,
		vectorRank: 1,
	})
	expect(oauthGuide.matches[0]?.keywords).toEqual(
		expect.arrayContaining(['oauth', 'redirect uri', 'provider registration']),
	)
	expect(oauthGuide.matches[0]).not.toHaveProperty('inputSchema')

	const guideSpecs = {
		kody_official_guide: specs.kody_official_guide,
	} satisfies Record<string, CapabilitySpec>
	const guideMatch = await searchCapabilities({
		env,
		query: 'guide',
		limit: 1,
		detail: true,
		specs: guideSpecs,
	})

	expect(guideMatch.matches[0]).not.toHaveProperty('inputSchema')
	expect(guideMatch.matches[0]).toMatchObject({
		inputTypeDefinition: expect.stringContaining('KodyOfficialGuideInput'),
	})
	expect(guideMatch.matches[0]).not.toHaveProperty('outputSchema')
})

test('online search semantically ranks runtime-only capabilities missing from Vectorize', async () => {
	const query = 'turn the living room tv on'
	const specs = {
		github_enable_issue_notifications: {
			name: 'github_enable_issue_notifications',
			domain: 'coding',
			description: 'Turn on GitHub issue notifications for a repository.',
			keywords: ['github', 'notifications', 'issues'],
			readOnly: false,
			idempotent: true,
			destructive: false,
			inputFields: ['owner', 'repo'],
			requiredInputFields: ['owner', 'repo'],
			outputFields: [],
			inputSchema: {
				type: 'object',
				properties: {
					owner: { type: 'string' },
					repo: { type: 'string' },
				},
				required: ['owner', 'repo'],
			},
			inputTypeDefinition:
				'type GithubEnableIssueNotificationsInput = {\n\towner: string\n\trepo: string\n}',
		},
		remote_display_press_key: {
			name: 'remote_display_press_key',
			domain: 'remote:display:default',
			description:
				'Wake a streaming display by sending a remote-control key command.',
			keywords: ['home', 'roku', 'remote', 'display', 'wake'],
			readOnly: false,
			idempotent: false,
			destructive: false,
			inputFields: ['deviceId', 'key'],
			requiredInputFields: ['deviceId', 'key'],
			outputFields: [],
			inputSchema: {
				type: 'object',
				properties: {
					deviceId: { type: 'string' },
					key: { type: 'string' },
				},
				required: ['deviceId', 'key'],
			},
			inputTypeDefinition:
				'type HomeRokuPressKeyInput = {\n\tdeviceId: string\n\tkey: string\n}',
		},
	} satisfies Record<string, CapabilitySpec>
	const env = {
		CAPABILITY_VECTOR_INDEX: {
			query() {
				return Promise.resolve({
					matches: [
						{
							id: 'github_enable_issue_notifications',
							score: 0.8,
						},
					],
					count: 1,
				})
			},
		},
	} as unknown as Env

	const { matches, offline } = await searchCapabilities({
		env,
		query,
		limit: 5,
		detail: false,
		specs,
		vectorMetadataFilter: {
			kind: { $eq: 'builtin' },
		},
	})

	expect(offline).toBe(false)
	const runtimeOnlyMatch = matches.find(
		(match) => match.name === 'remote_display_press_key',
	)
	expect(runtimeOnlyMatch).toBeDefined()
	expect(runtimeOnlyMatch?.vectorRank).toEqual(expect.any(Number))
	expect(matches[0]?.name).toBe('github_enable_issue_notifications')
})
