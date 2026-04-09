import { expect, test } from 'vitest'
import {
	buildCapabilityEmbedText,
	CAPABILITY_EMBEDDING_DIMENSIONS,
	deterministicEmbedding,
	lexicalScore,
	searchCapabilities,
} from './capability-search.ts'
import { type CapabilitySpec } from './types.ts'
import { capabilitySpecs } from './registry.ts'

test('buildCapabilityEmbedText includes name domain description keywords fields', () => {
	const spec = capabilitySpecs.ui_save_app!
	const text = buildCapabilityEmbedText(spec)
	expect(text).toContain('ui_save_app')
	expect(text).toContain('apps')
	expect(text).toContain('source')
	expect(text.length).toBeGreaterThan(10)
})

test('deterministicEmbedding has fixed dimension and unit norm', () => {
	const a = deterministicEmbedding('hello', CAPABILITY_EMBEDDING_DIMENSIONS)
	expect(a.length).toBe(CAPABILITY_EMBEDDING_DIMENSIONS)
	let sum = 0
	for (const x of a) sum += x * x
	expect(sum).toBeCloseTo(1, 5)
})

test('lexicalScore prefers overlapping tokens', () => {
	const doc = 'github rest api issues pull request repository'
	expect(lexicalScore('github issues', doc)).toBeGreaterThan(
		lexicalScore('weather forecast', doc),
	)
})

test('offline search returns provided specs without depending on global ranks', async () => {
	const specs = {
		kody_official_guide: {
			name: 'kody_official_guide',
			domain: 'coding',
			description:
				'Load official Kody guides: integration_bootstrap, oauth (/connect/oauth), generated_ui_oauth (saved app), connect_secret.',
			keywords: [
				'integration bootstrap',
				'oauth',
				'generated ui',
				'redirect uri',
				'provider registration',
				'secret',
			],
			readOnly: true,
			idempotent: true,
			destructive: false,
			inputFields: ['guide'],
			requiredInputFields: ['guide'],
			outputFields: ['title', 'body'],
			inputSchema: {
				type: 'object',
				properties: {
					guide: {
						type: 'string',
						enum: [
							'integration_bootstrap',
							'oauth',
							'generated_ui_oauth',
							'connect_secret',
						],
					},
				},
				required: ['guide'],
			},
		},
	} satisfies Record<string, CapabilitySpec>
	const env = {
		SENTRY_ENVIRONMENT: 'test',
		AI: {} as Ai,
	} as Env

	const { matches, offline } = await searchCapabilities({
		env,
		query: 'oauth redirect uri provider registration',
		limit: 8,
		detail: true,
		specs,
	})

	expect(offline).toBe(true)
	expect(matches).toHaveLength(1)
	expect(matches[0]?.name).toBe('kody_official_guide')
	expect(matches[0]?.keywords).toEqual(
		expect.arrayContaining(['oauth', 'redirect uri', 'provider registration']),
	)
	expect(matches[0]?.outputFields).toEqual(['title', 'body'])
	expect(matches[0]?.lexicalRank).toBe(1)
	expect(matches[0]?.vectorRank).toBe(1)
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
		},
		home_roku_press_key: {
			name: 'home_roku_press_key',
			domain: 'home',
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
		},
	} satisfies Record<string, CapabilitySpec>
	const env = {
		AI: {
			run(_model: string, input: { text: string | Array<string> }) {
				const texts = Array.isArray(input.text) ? input.text : [input.text]
				return Promise.resolve({
					data: texts.map((text) => {
						if (text === query) return [1, 0]
						if (text.includes('remote-control key command')) return [1, 0]
						return [0, 1]
					}),
				})
			},
		},
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
	expect(matches[0]?.name).toBe('home_roku_press_key')
	expect(matches[0]?.vectorRank).toBe(1)
	expect(matches[1]?.name).toBe('github_enable_issue_notifications')
})
