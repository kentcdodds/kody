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
	const spec = capabilitySpecs.do_math!
	const text = buildCapabilityEmbedText(spec)
	expect(text).toContain('do_math')
	expect(text).toContain('math')
	expect(text).toContain('operator')
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

test('fusion ranking returns do_math for arithmetic query (offline)', async () => {
	const env = {
		SENTRY_ENVIRONMENT: 'test',
		AI: {} as Ai,
	} as Env

	const { matches, offline } = await searchCapabilities({
		env,
		query: 'calculation add subtract multiply divide finite number arithmetic',
		limit: 8,
		detail: false,
		specs: capabilitySpecs,
	})

	expect(offline).toBe(true)
	const names = matches.map((m) => m.name)
	expect(names).toContain('do_math')
	expect(names[0]).toBe('do_math')
})
