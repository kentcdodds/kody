import { expect, test } from 'bun:test'
import {
	buildCapabilityEmbedText,
	CAPABILITY_EMBEDDING_DIMENSIONS,
	deterministicEmbedding,
	lexicalScore,
	searchCapabilities,
} from './capability-search.ts'
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
		query: 'save generated ui app source and reopen by app id',
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
