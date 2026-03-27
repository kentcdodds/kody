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

test('fusion ranking returns ui_save_app for generated ui query (offline)', async () => {
	const env = {
		SENTRY_ENVIRONMENT: 'test',
		AI: {} as Ai,
	} as Env

	const { matches, offline } = await searchCapabilities({
		env,
		query: 'ui_save_app save generated ui artifact source app_id',
		limit: 8,
		detail: false,
		specs: capabilitySpecs,
	})

	expect(offline).toBe(true)
	const names = matches.map((m) => m.name)
	expect(names).toContain('ui_save_app')
	const appRank = names.indexOf('ui_save_app')
	expect(appRank).toBeGreaterThanOrEqual(0)
	expect(appRank).toBeLessThan(5)
})

test('fusion ranking returns generated_ui_oauth_guide for oauth ui query (offline)', async () => {
	const env = {
		SENTRY_ENVIRONMENT: 'test',
		AI: {} as Ai,
	} as Env

	const { matches, offline } = await searchCapabilities({
		env,
		query:
			'generated ui oauth callback redirect uri host approval provider registration',
		limit: 8,
		detail: false,
		specs: capabilitySpecs,
	})

	expect(offline).toBe(true)
	const names = matches.map((m) => m.name)
	expect(names).toContain('generated_ui_oauth_guide')
	const guideRank = names.indexOf('generated_ui_oauth_guide')
	expect(guideRank).toBeGreaterThanOrEqual(0)
	expect(guideRank).toBeLessThan(5)
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
