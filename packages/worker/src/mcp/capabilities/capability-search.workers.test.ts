import { expect, test } from 'vitest'
import {
	CAPABILITY_EMBEDDING_DIMENSIONS,
	CAPABILITY_EMBEDDING_MODEL,
	deterministicEmbedding,
	embedTextsForVectorize,
	lexicalScore,
	searchCapabilities,
} from './capability-search.ts'
import { type CapabilitySpec } from './types.ts'

function embeddingRow(seed: number) {
	return Array.from(
		{ length: CAPABILITY_EMBEDDING_DIMENSIONS },
		(_, index) => seed + index / 1_000,
	)
}

function aiEnv(
	run: (...args: Array<unknown>) => Promise<unknown>,
	extra: Partial<Env> & { AI_GATEWAY_ID?: string } = {},
) {
	return {
		SENTRY_ENVIRONMENT: 'production',
		AI: { run } as unknown as Ai,
		...extra,
	} as Env
}

test('offline capability search ranks lexical matches and returns structured detail without schema fields', async () => {
	const doc = 'alpha beta gamma delta epsilon'
	expect(lexicalScore('alpha beta', doc)).toBeGreaterThan(
		lexicalScore('omega zeta', doc),
	)

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
	} satisfies Record<string, CapabilitySpec>
	const env = {
		SENTRY_ENVIRONMENT: 'test',
		AI: {} as Ai,
	} as Env

	const oauthGuide = await searchCapabilities({
		env,
		query: 'oauth redirect uri provider registration',
		limit: 8,
		detail: true,
		specs,
	})

	expect(oauthGuide.offline).toBe(true)
	expect(oauthGuide.matches).toHaveLength(1)
	expect(oauthGuide.matches[0]).toMatchObject({
		name: 'oauth_setup_guide',
		outputFields: ['title', 'body'],
		lexicalRank: 1,
		vectorRank: 1,
	})
	expect(oauthGuide.matches[0]).not.toHaveProperty('inputSchema')
	expect(oauthGuide.matches[0]).toMatchObject({
		inputTypeDefinition: expect.stringContaining('OAuthSetupGuideInput'),
	})
	expect(oauthGuide.matches[0]).not.toHaveProperty('outputSchema')
})

test('embedding wrapper returns empty input without calling Workers AI', async () => {
	let called = false
	const env = aiEnv(async () => {
		called = true
		return { data: [embeddingRow(1)] }
	})

	await expect(embedTextsForVectorize(env, [])).resolves.toEqual([])
	expect(called).toBe(false)
})

test('embedding wrapper batches texts through Workers AI and AI Gateway', async () => {
	const calls: Array<Array<unknown>> = []
	const rows = [embeddingRow(1), embeddingRow(2)]
	const env = aiEnv(
		async (...args) => {
			calls.push(args)
			return { data: rows, shape: [2, CAPABILITY_EMBEDDING_DIMENSIONS] }
		},
		{ AI_GATEWAY_ID: ' gateway-123 ' },
	)

	await expect(embedTextsForVectorize(env, ['alpha', 'beta'])).resolves.toEqual(
		rows,
	)
	expect(calls).toEqual([
		[
			CAPABILITY_EMBEDDING_MODEL,
			{ text: ['alpha', 'beta'], pooling: 'cls' },
			{ gateway: { id: 'gateway-123' } },
		],
	])
})

test('embedding wrapper falls back deterministically outside production when AI is unavailable', async () => {
	const env = { SENTRY_ENVIRONMENT: 'preview' } as Env

	await expect(embedTextsForVectorize(env, ['alpha', 'beta'])).resolves.toEqual(
		[deterministicEmbedding('alpha'), deterministicEmbedding('beta')],
	)
})

test('embedding wrapper rejects mismatched Workers AI row counts', async () => {
	const env = aiEnv(async () => ({
		data: [embeddingRow(1)],
		shape: [1, CAPABILITY_EMBEDDING_DIMENSIONS],
	}))

	await expect(embedTextsForVectorize(env, ['alpha', 'beta'])).rejects.toThrow(
		/row count mismatch/,
	)
})

test('embedding wrapper rejects mismatched Workers AI dimensions', async () => {
	const env = aiEnv(async () => ({
		data: [
			Array.from({ length: CAPABILITY_EMBEDDING_DIMENSIONS - 1 }, () => 0),
		],
		shape: [1, CAPABILITY_EMBEDDING_DIMENSIONS - 1],
	}))

	await expect(embedTextsForVectorize(env, ['alpha'])).rejects.toThrow(
		/shape mismatch/,
	)
})
