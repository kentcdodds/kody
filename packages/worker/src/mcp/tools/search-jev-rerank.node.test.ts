import { expect, test, vi } from 'vitest'
import { consoleWarn } from '#worker/test-support/console-spies.ts'

import {
	jevSearchMinKeepScore,
	jevSearchModel,
	jevSearchScoreQuestionBatchSize,
	normalizeJevRunResponse,
	rerankSearchCandidatesWithJev,
	resolveJevSearchRecallLimit,
} from './search-jev-rerank.ts'
import { type SearchCandidate } from './search-types.ts'
import { type SearchIntent } from './understand-search-query.ts'

function makeCandidate(
	overrides: Partial<SearchCandidate> & {
		id: string
		title: string
	},
): SearchCandidate {
	return {
		match: {
			type: 'capability',
			id: overrides.id,
			entityRef: `capability:${overrides.id}`,
			title: overrides.title,
			description: `${overrides.title} description`,
			domain: 'meta',
			usage: 'example',
		},
		type: 'capability',
		id: overrides.id,
		title: overrides.title,
		searchFields: [overrides.title],
		scoreComponents: {
			base: 1,
			lexical: 1,
			vector: 0,
			entityMatch: 0,
			providerEntityAffinity: 0,
			actionMatch: 0,
			taskAffinity: 0,
			appAvailability: 0,
			wrapperWorkflow: 0,
			constraint: 0,
			final: 1,
		},
		...overrides,
	}
}

function makeCandidates(count: number): Array<SearchCandidate> {
	return Array.from({ length: count }, (_, index) =>
		makeCandidate({
			id: `card-${String(index)}`,
			title: `Card ${String(index)}`,
		}),
	)
}

function scoreAnswersForQuestions(
	questions: Record<string, unknown>,
	scoreForKey: (key: string) => { score: number; confidence: number },
): Record<string, { type: 'score'; score: number; confidence: number }> {
	return Object.fromEntries(
		Object.keys(questions).map((key) => [
			key,
			{ type: 'score', ...scoreForKey(key) },
		]),
	)
}

function jevRunBody(run: ReturnType<typeof vi.fn>, callIndex: number) {
	return run.mock.calls[callIndex]?.[1] as {
		questions: Record<string, unknown>
		state: { candidates: Array<unknown> }
	}
}

function makeIntent(query: string, confidence: number): SearchIntent {
	return {
		normalizedQuery: query,
		tokens: query.split(' '),
		meaningfulTokens: query.split(' '),
		phrases: [query],
		task: { name: 'inspect', confidence },
		actions: [],
		entities: [],
		constraints: [],
		confidence,
	}
}

test('resolveJevSearchRecallLimit widens only when requested', () => {
	expect(resolveJevSearchRecallLimit({ limit: 15, widerRecall: false })).toBe(
		15,
	)
	expect(resolveJevSearchRecallLimit({ limit: 15, widerRecall: true })).toBe(50)
	expect(resolveJevSearchRecallLimit({ limit: 80, widerRecall: true })).toBe(80)
})

test('rerankSearchCandidatesWithJev skips, applies Score order, and falls back', async () => {
	const pair = [
		makeCandidate({ id: 'a', title: 'A' }),
		makeCandidate({ id: 'b', title: 'B' }),
	]
	const ranked = [
		makeCandidate({ id: 'noise', title: 'Noise' }),
		makeCandidate({ id: 'email', title: 'Email' }),
		makeCandidate({ id: 'weak', title: 'Weak' }),
	]
	const intent = makeIntent('send email', 0.9)

	const offline = await rerankSearchCandidatesWithJev({
		env: {} as Env,
		query: 'send email',
		intent,
		candidates: pair,
		limit: 1,
		offline: true,
		enabled: true,
	})
	expect(offline.outcome).toBe('skipped-offline')
	expect(offline.candidates).toEqual([pair[0]])
	expect(offline.model).toBe(jevSearchModel)
	expect(offline.aiCallCount).toBe(0)
	expect(offline.usage).toEqual({ inputTokens: null, outputTokens: null })

	const unusedRun = vi.fn()
	const flagOff = await rerankSearchCandidatesWithJev({
		env: { AI: { run: unusedRun } } as unknown as Env,
		query: 'send email',
		intent,
		candidates: pair,
		limit: 1,
		offline: false,
		enabled: false,
	})
	expect(flagOff.outcome).toBe('skipped-flag-off')
	expect(flagOff.candidates).toEqual([pair[0]])
	expect(flagOff.model).toBeUndefined()
	expect(flagOff.aiCallCount).toBeUndefined()
	expect(flagOff.usage).toBeUndefined()
	expect(unusedRun).not.toHaveBeenCalled()

	const applyRun = vi.fn(async () => ({
		answers: {
			c0: { type: 'score', score: 0.2, confidence: 0.9 },
			c1: { type: 'score', score: 2.7, confidence: 0.95 },
			c2: {
				type: 'score',
				score: jevSearchMinKeepScore - 0.2,
				confidence: 0.8,
			},
		},
	}))
	const applied = await rerankSearchCandidatesWithJev({
		env: {
			AI: { run: applyRun },
			AI_GATEWAY_ID: 'kody',
		} as unknown as Env,
		query: 'send email',
		intent,
		candidates: ranked,
		limit: 2,
		offline: false,
		enabled: true,
	})
	expect(applied.outcome).toBe('applied')
	expect(applied.errorReason).toBeUndefined()
	expect(applied.model).toBe(jevSearchModel)
	expect(applied.aiCallCount).toBe(1)
	expect(applied.usage).toEqual({ inputTokens: null, outputTokens: null })
	expect(applied.candidates.map((candidate) => candidate.id)).toEqual(['email'])
	expect(applied.droppedCount).toBe(2)
	expect(applied.top1Type).toBe('capability')
	expect(applyRun).toHaveBeenCalledOnce()
	expect(applyRun.mock.calls[0]?.[0]).toBe('typesafe/jev')
	expect(applyRun.mock.calls[0]?.[2]).toEqual({ gateway: { id: 'kody' } })
	expect(applyRun.mock.calls[0]?.[1]).toEqual(
		expect.objectContaining({
			state: expect.objectContaining({
				query: 'send email',
				candidates: [
					{
						index: 0,
						type: 'capability',
						id: 'noise',
						title: 'Noise',
						summary: 'Noise description',
						domain: 'meta',
					},
					{
						index: 1,
						type: 'capability',
						id: 'email',
						title: 'Email',
						summary: 'Email description',
						domain: 'meta',
					},
					{
						index: 2,
						type: 'capability',
						id: 'weak',
						title: 'Weak',
						summary: 'Weak description',
						domain: 'meta',
					},
				],
			}),
		}),
	)

	const emptyAfterDropRun = vi.fn(async () => ({
		answers: {
			c0: {
				type: 'score',
				score: jevSearchMinKeepScore - 1,
				confidence: 0.9,
			},
			c1: {
				type: 'score',
				score: jevSearchMinKeepScore - 0.1,
				confidence: 0.95,
			},
		},
	}))
	const emptyAfterDrop = await rerankSearchCandidatesWithJev({
		env: {
			AI: { run: emptyAfterDropRun },
			AI_GATEWAY_ID: 'kody',
		} as unknown as Env,
		query: 'send email',
		intent,
		candidates: pair,
		limit: 2,
		offline: false,
		enabled: true,
	})
	expect(emptyAfterDrop.outcome).toBe('fallback-empty-after-drop')
	expect(emptyAfterDrop.candidates.map((candidate) => candidate.id)).toEqual([
		'a',
		'b',
	])

	consoleWarn.mockImplementation(() => {})
	const missingGatewayRun = vi.fn()
	const missingGateway = await rerankSearchCandidatesWithJev({
		env: { AI: { run: missingGatewayRun } } as unknown as Env,
		query: 'packages',
		intent: makeIntent('packages', 0.7),
		candidates: pair,
		limit: 2,
		offline: false,
		enabled: true,
	})
	expect(missingGateway.outcome).toBe('fallback-error')
	expect(missingGateway.errorReason).toBe(
		'ai-gateway-required-for-typesafe-jev',
	)
	expect(missingGateway.model).toBe(jevSearchModel)
	expect(missingGateway.aiCallCount).toBe(0)
	expect(missingGateway.usage).toEqual({
		inputTokens: null,
		outputTokens: null,
	})
	expect(missingGateway.candidates.map((candidate) => candidate.id)).toEqual([
		'a',
		'b',
	])
	expect(missingGatewayRun).not.toHaveBeenCalled()

	const blankGatewayRun = vi.fn()
	const blankGateway = await rerankSearchCandidatesWithJev({
		env: {
			AI: { run: blankGatewayRun },
			AI_GATEWAY_ID: '   ',
		} as unknown as Env,
		query: 'packages',
		intent: makeIntent('packages', 0.7),
		candidates: pair,
		limit: 2,
		offline: false,
		enabled: true,
	})
	expect(blankGateway.outcome).toBe('fallback-error')
	expect(blankGateway.errorReason).toBe('ai-gateway-required-for-typesafe-jev')
	expect(blankGatewayRun).not.toHaveBeenCalled()

	const failingRun = vi.fn(async () => {
		throw new Error(
			'Insufficient balance; add money to your gateway or use BYOK',
		)
	})
	const fallbackError = await rerankSearchCandidatesWithJev({
		env: {
			AI: { run: failingRun },
			AI_GATEWAY_ID: 'kody',
		} as unknown as Env,
		query: 'packages',
		intent: makeIntent('packages', 0.7),
		candidates: pair,
		limit: 2,
		offline: false,
		enabled: true,
	})
	expect(fallbackError.outcome).toBe('fallback-error')
	expect(fallbackError.errorReason).toBe(
		'Insufficient balance; add money to your gateway or use BYOK',
	)
	expect(fallbackError.candidates.map((candidate) => candidate.id)).toEqual([
		'a',
		'b',
	])
	expect(failingRun).toHaveBeenCalledOnce()
	expect(failingRun.mock.calls[0]?.[2]).toEqual({ gateway: { id: 'kody' } })
	expect(consoleWarn).toHaveBeenCalled()

	const longMessage = `Gateway authentication is required to use unified billing. ${'x'.repeat(300)}`
	const longErrorRun = vi.fn(async () => {
		throw new Error(longMessage)
	})
	const longError = await rerankSearchCandidatesWithJev({
		env: {
			AI: { run: longErrorRun },
			AI_GATEWAY_ID: 'kody',
		} as unknown as Env,
		query: 'packages',
		intent: makeIntent('packages', 0.7),
		candidates: pair,
		limit: 2,
		offline: false,
		enabled: true,
	})
	expect(longError.outcome).toBe('fallback-error')
	expect(longError.errorReason).toBeDefined()
	expect(longError.errorReason?.length).toBeLessThanOrEqual(240)
	expect(longError.errorReason?.endsWith('...')).toBe(true)
	expect(longErrorRun).toHaveBeenCalledOnce()

	const blankMessageRun = vi.fn(async () => {
		throw new Error('   ')
	})
	const blankMessage = await rerankSearchCandidatesWithJev({
		env: {
			AI: { run: blankMessageRun },
			AI_GATEWAY_ID: 'kody',
		} as unknown as Env,
		query: 'packages',
		intent: makeIntent('packages', 0.7),
		candidates: pair,
		limit: 2,
		offline: false,
		enabled: true,
	})
	expect(blankMessage.outcome).toBe('fallback-error')
	expect(blankMessage.errorReason).toBe('unknown-jev-error')
	expect(blankMessageRun).toHaveBeenCalledOnce()

	const incompleteRun = vi.fn(async () => ({
		answers: {
			c0: { type: 'score', score: 2.4 },
		},
	}))
	const incompleteAnswers = await rerankSearchCandidatesWithJev({
		env: {
			AI: { run: incompleteRun },
			AI_GATEWAY_ID: 'kody',
		} as unknown as Env,
		query: 'packages',
		intent: makeIntent('packages', 0.7),
		candidates: pair,
		limit: 2,
		offline: false,
		enabled: true,
	})
	expect(incompleteAnswers.outcome).toBe('fallback-error')
	expect(incompleteAnswers.errorReason).toBe(
		'incomplete-score-answers expected=2 received=0 keys=answers result.answers=missing answerKeys=c0',
	)
	expect(incompleteRun).toHaveBeenCalledOnce()

	const widePool = makeCandidates(jevSearchScoreQuestionBatchSize + 4)
	const bestWideId = widePool[widePool.length - 1]!.id
	const multiBatchRun = vi.fn(
		async (_model: string, body: { questions: Record<string, unknown> }) => {
			const keys = Object.keys(body.questions)
			return {
				answers: scoreAnswersForQuestions(body.questions, (key) => {
					if (key === `c${String(widePool.length - 1)}`) {
						return { score: 2.8, confidence: 0.96 }
					}
					return { score: 0.3, confidence: 0.9 }
				}),
				usage: keys.includes('c0')
					? { prompt_tokens: 40, completion_tokens: 12 }
					: { input_tokens: 18, output_tokens: 7 },
			}
		},
	)
	const multiBatch = await rerankSearchCandidatesWithJev({
		env: {
			AI: { run: multiBatchRun },
			AI_GATEWAY_ID: 'kody',
		} as unknown as Env,
		query: 'send email',
		intent,
		candidates: widePool,
		limit: 2,
		offline: false,
		enabled: true,
	})
	expect(multiBatch.outcome).toBe('applied')
	expect(multiBatch.errorReason).toBeUndefined()
	expect(multiBatch.model).toBe(jevSearchModel)
	expect(multiBatch.aiCallCount).toBe(2)
	expect(multiBatch.usage).toEqual({ inputTokens: 58, outputTokens: 19 })
	expect(multiBatch.candidates.map((candidate) => candidate.id)).toEqual([
		bestWideId,
	])
	expect(multiBatchRun).toHaveBeenCalledTimes(2)
	expect(multiBatchRun.mock.calls[0]?.[2]).toEqual({ gateway: { id: 'kody' } })
	expect(multiBatchRun.mock.calls[1]?.[2]).toEqual({ gateway: { id: 'kody' } })
	expect(Object.keys(jevRunBody(multiBatchRun, 0).questions)).toEqual(
		Array.from(
			{ length: jevSearchScoreQuestionBatchSize },
			(_, index) => `c${String(index)}`,
		),
	)
	expect(Object.keys(jevRunBody(multiBatchRun, 1).questions)).toEqual(
		Array.from(
			{ length: 4 },
			(_, index) => `c${String(jevSearchScoreQuestionBatchSize + index)}`,
		),
	)
	expect(jevRunBody(multiBatchRun, 0).state.candidates).toHaveLength(
		widePool.length,
	)
	expect(jevRunBody(multiBatchRun, 1).state.candidates).toHaveLength(
		widePool.length,
	)

	const partialBatchRun = vi.fn(
		async (_model: string, body: { questions: Record<string, unknown> }) => {
			const keys = Object.keys(body.questions)
			if (!keys.includes('c0')) {
				return { answers: {} }
			}
			return {
				answers: scoreAnswersForQuestions(body.questions, () => ({
					score: 2.1,
					confidence: 0.9,
				})),
			}
		},
	)
	const partialBatch = await rerankSearchCandidatesWithJev({
		env: {
			AI: { run: partialBatchRun },
			AI_GATEWAY_ID: 'kody',
		} as unknown as Env,
		query: 'send email',
		intent,
		candidates: widePool,
		limit: 2,
		offline: false,
		enabled: true,
	})
	expect(partialBatch.outcome).toBe('fallback-error')
	expect(partialBatch.model).toBe(jevSearchModel)
	expect(partialBatch.aiCallCount).toBe(2)
	expect(partialBatch.errorReason).toBe(
		`incomplete-score-answers expected=${String(widePool.length)} received=${String(jevSearchScoreQuestionBatchSize)} keys=answers result.answers=missing answerKeys=${Array.from({ length: jevSearchScoreQuestionBatchSize }, (_, index) => `c${String(index)}`).join(',')}`,
	)
	expect(partialBatch.candidates.map((candidate) => candidate.id)).toEqual([
		widePool[0]!.id,
		widePool[1]!.id,
	])
	expect(partialBatchRun).toHaveBeenCalledTimes(2)
	expect(partialBatchRun.mock.calls[0]?.[2]).toEqual({
		gateway: { id: 'kody' },
	})
	expect(partialBatchRun.mock.calls[1]?.[2]).toEqual({
		gateway: { id: 'kody' },
	})
})

test('normalizeJevRunResponse unwraps gateway envelopes and docs Score payloads', () => {
	const docsScoreAnswer = {
		type: 'score' as const,
		score: 1.04,
		confidence: 0.94,
		legend: {
			'0': 'Calm',
			'1': 'Frustrated',
			'2': 'Very angry',
		},
		probabilities: {
			'0': 0,
			'1': 0.96,
			'2': 0.04,
		},
	}
	const docsUsage = { input_tokens: 426, output_tokens: 73 }
	const unwrapped = normalizeJevRunResponse({
		model: 'jev-1.13.0',
		answers: { frustration: docsScoreAnswer },
		usage: docsUsage,
	})
	expect(unwrapped.rawTopLevelKeys).toEqual(['model', 'answers', 'usage'])
	expect(unwrapped.resultAnswers).toBe('missing')
	expect(unwrapped.payload.answers).toEqual({ frustration: docsScoreAnswer })
	expect(unwrapped.payload.usage).toEqual(docsUsage)

	const wrapped = normalizeJevRunResponse({
		success: true,
		errors: [],
		messages: [],
		result: {
			model: 'jev-1.13.0',
			answers: { frustration: docsScoreAnswer },
			usage: docsUsage,
		},
	})
	expect(wrapped.rawTopLevelKeys).toEqual([
		'success',
		'errors',
		'messages',
		'result',
	])
	expect(wrapped.resultAnswers).toBe('object')
	expect(wrapped.payload.answers).toEqual({ frustration: docsScoreAnswer })
	expect(wrapped.payload.usage).toEqual(docsUsage)

	const nestedResponseUsage = { input_tokens: 40, output_tokens: 8 }
	const nestedResponse = normalizeJevRunResponse({
		success: true,
		result: {
			response: JSON.stringify({
				answers: { frustration: docsScoreAnswer },
			}),
			usage: nestedResponseUsage,
		},
	})
	expect(nestedResponse.resultAnswers).toBe('missing')
	expect(nestedResponse.payload.answers).toEqual({
		frustration: docsScoreAnswer,
	})
	expect(nestedResponse.payload.usage).toEqual(nestedResponseUsage)
})

test('rerankSearchCandidatesWithJev applies wrapped gateway Score answers and samples missing-answer keys', async () => {
	const pair = [
		makeCandidate({ id: 'a', title: 'A' }),
		makeCandidate({ id: 'b', title: 'B' }),
	]
	const intent = makeIntent('send email', 0.9)

	const wrappedRun = vi.fn(async () => ({
		success: true,
		errors: [],
		messages: [],
		result: {
			model: 'jev-1.13.0',
			answers: {
				c0: { type: 'score', score: 0.2, confidence: 0.9 },
				c1: { type: 'score', score: 2.7, confidence: 0.95 },
			},
			usage: { input_tokens: 426, output_tokens: 73 },
		},
	}))
	const wrapped = await rerankSearchCandidatesWithJev({
		env: {
			AI: { run: wrappedRun },
			AI_GATEWAY_ID: 'kody',
		} as unknown as Env,
		query: 'send email',
		intent,
		candidates: pair,
		limit: 2,
		offline: false,
		enabled: true,
	})
	expect(wrapped.outcome).toBe('applied')
	expect(wrapped.errorReason).toBeUndefined()
	expect(wrapped.candidates.map((candidate) => candidate.id)).toEqual(['b'])
	expect(wrapped.usage).toEqual({ inputTokens: 426, outputTokens: 73 })
	expect(wrappedRun).toHaveBeenCalledOnce()

	const unwrappedRun = vi.fn(async () => ({
		model: 'jev-1.13.0',
		answers: {
			c0: { type: 'score', score: 2.8, confidence: 0.91 },
			c1: { type: 'score', score: 0.4, confidence: 0.88 },
		},
		usage: { input_tokens: 190, output_tokens: 0 },
	}))
	const unwrapped = await rerankSearchCandidatesWithJev({
		env: {
			AI: { run: unwrappedRun },
			AI_GATEWAY_ID: 'kody',
		} as unknown as Env,
		query: 'send email',
		intent,
		candidates: pair,
		limit: 2,
		offline: false,
		enabled: true,
	})
	expect(unwrapped.outcome).toBe('applied')
	expect(unwrapped.candidates.map((candidate) => candidate.id)).toEqual(['a'])
	expect(unwrapped.usage).toEqual({ inputTokens: 190, outputTokens: 0 })

	const envelopeWithoutAnswers = vi.fn(async () => ({
		success: true,
		errors: [],
		result: { model: 'jev-1.13.0' },
	}))
	const missingAnswers = await rerankSearchCandidatesWithJev({
		env: {
			AI: { run: envelopeWithoutAnswers },
			AI_GATEWAY_ID: 'kody',
		} as unknown as Env,
		query: 'send email',
		intent,
		candidates: pair,
		limit: 2,
		offline: false,
		enabled: true,
	})
	expect(missingAnswers.outcome).toBe('fallback-error')
	expect(missingAnswers.errorReason).toBe(
		'incomplete-score-answers expected=2 received=0 keys=success,errors,result result.answers=missing answerKeys=none',
	)
	expect(missingAnswers.usage).toEqual({
		inputTokens: null,
		outputTokens: null,
	})
})
