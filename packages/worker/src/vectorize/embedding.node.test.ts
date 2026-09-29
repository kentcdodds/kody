import { expect, test, vi } from 'vitest'
import {
	CAPABILITY_EMBEDDING_BATCH_SIZE,
	CAPABILITY_EMBEDDING_DIMENSIONS,
	CAPABILITY_EMBEDDING_MAX_INPUT_CHARS,
	CAPABILITY_EMBEDDING_MODEL,
	createTextEmbeddingCache,
	deterministicEmbedding,
	embedTextsForVectorize,
} from './embedding.ts'

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

test('embedding wrapper returns empty input without calling Workers AI', async () => {
	let called = false
	const env = aiEnv(async () => {
		called = true
		return { data: [embeddingRow(1)] }
	})

	await expect(embedTextsForVectorize(env, [])).resolves.toEqual([])
	expect(called).toBe(false)
})

test('embedding wrapper batches texts through AI Gateway and falls back to direct Workers AI when the gateway fails', async () => {
	const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {})
	const rows = [embeddingRow(1), embeddingRow(2)]
	const request = { text: ['alpha', 'beta'], pooling: 'cls' }
	for (const [gatewayId, gatewayFails, expectedCalls] of [
		[
			' gateway-123 ',
			false,
			[
				[
					CAPABILITY_EMBEDDING_MODEL,
					request,
					{ gateway: { id: 'gateway-123' } },
				],
			],
		],
		[
			'stale-gateway',
			true,
			[
				[
					CAPABILITY_EMBEDDING_MODEL,
					request,
					{ gateway: { id: 'stale-gateway' } },
				],
				[CAPABILITY_EMBEDDING_MODEL, request, undefined],
			],
		],
	] as const) {
		const calls: Array<Array<unknown>> = []
		const env = aiEnv(
			async (...args) => {
				calls.push(args)
				if (gatewayFails && args[2]) throw new Error('gateway not found')
				return { data: rows, shape: [2, CAPABILITY_EMBEDDING_DIMENSIONS] }
			},
			{ AI_GATEWAY_ID: gatewayId },
		)
		await expect(
			embedTextsForVectorize(env, ['alpha', 'beta']),
		).resolves.toEqual(rows)
		expect(calls).toEqual(expectedCalls)
	}
	expect(consoleWarn).toHaveBeenCalledExactlyOnceWith(
		expect.stringContaining('retrying direct Workers AI'),
	)
	consoleWarn.mockRestore()
})

test('embedding wrapper chunks large batches and truncates long inputs', async () => {
	const calls: Array<Array<unknown>> = []
	const inputCount = CAPABILITY_EMBEDDING_BATCH_SIZE + 1
	const env = aiEnv(async (...args) => {
		calls.push(args)
		const payload = args[1] as { text: Array<string> }
		return {
			data: payload.text.map((_, index) =>
				embeddingRow(calls.length * 10 + index),
			),
			shape: [payload.text.length, CAPABILITY_EMBEDDING_DIMENSIONS],
		}
	})

	await expect(
		embedTextsForVectorize(env, [
			'x'.repeat(CAPABILITY_EMBEDDING_MAX_INPUT_CHARS + 500),
			...Array.from({ length: inputCount - 1 }, (_, index) => `text-${index}`),
		]),
	).resolves.toHaveLength(inputCount)

	expect(calls).toHaveLength(2)
	expect(
		calls.map((args) => (args[1] as { text: Array<string> }).text.length),
	).toEqual([CAPABILITY_EMBEDDING_BATCH_SIZE, 1])
	expect(
		(calls[0]![1] as { text: Array<string> }).text.every(
			(text) => text.length <= CAPABILITY_EMBEDDING_MAX_INPUT_CHARS,
		),
	).toBe(true)
})

test('embedding wrapper falls back deterministically outside production when AI is unavailable', async () => {
	const env = { SENTRY_ENVIRONMENT: 'preview' } as Env

	await expect(embedTextsForVectorize(env, ['alpha', 'beta'])).resolves.toEqual(
		[deterministicEmbedding('alpha'), deterministicEmbedding('beta')],
	)
})

test('embedding wrapper reports direct Workers AI failures and mismatched rows or dimensions', async () => {
	const short = CAPABILITY_EMBEDDING_DIMENSIONS - 1
	for (const [run, texts, error] of [
		[
			async () => {
				throw new Error('workers ai unavailable')
			},
			['alpha'],
			/workers ai unavailable/,
		],
		[
			async () => ({
				data: [embeddingRow(1)],
				shape: [1, CAPABILITY_EMBEDDING_DIMENSIONS],
			}),
			['alpha', 'beta'],
			/row count mismatch/,
		],
		[
			async () => ({
				data: [Array.from({ length: short }, () => 0)],
				shape: [1, short],
			}),
			['alpha'],
			/shape mismatch/,
		],
	] as const) {
		await expect(
			embedTextsForVectorize(aiEnv(run), [...texts]),
		).rejects.toThrow(error)
	}
})

test('createTextEmbeddingCache embeds each distinct text once and shares the pending promise', async () => {
	const texts: Array<Array<string>> = []
	const env = aiEnv(async (...args) => {
		const input = args[1] as { text?: Array<string> }
		texts.push([...(input.text ?? [])])
		return {
			data: (input.text ?? []).map((text) => deterministicEmbedding(text)),
			shape: [input.text?.length ?? 0, CAPABILITY_EMBEDDING_DIMENSIONS],
		}
	})
	const cache = createTextEmbeddingCache(env)

	const [first, again, other] = await Promise.all([
		cache.embedText('summarize inbox threads'),
		cache.embedText('summarize inbox threads'),
		cache.embedText('draft an email'),
	])

	expect(texts).toEqual([['summarize inbox threads'], ['draft an email']])
	expect(first).toEqual(again)
	expect(first).not.toEqual(other)
})
