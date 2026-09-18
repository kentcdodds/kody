/**
 * Stage-2 Jev Score rerank/filter for ranked MCP `search({ query })`.
 *
 * Hybrid lexical+vector recall stays the retriever. When the
 * `jev-search-rerank` flag is on, a wider candidate pool is scored by
 * Workers AI `typesafe/jev` through AI Gateway. Score questions are sent
 * in small batches that share the same skinny-card state; answers are
 * unwrapped from known Gateway envelopes, then merged before parse.
 * That third-party model requires Gateway
 * authentication and Unified Billing (or BYOK); the Worker does not fall
 * back to direct Workers AI. Failures and low confidence fall back to
 * the pre-Jev hybrid order for the same pool.
 *
 * Offline / deterministic embedding paths never call Jev.
 */

import { getErrorMessage } from '@kody-internal/shared/error-message.ts'
import { jevSearchRerankFlagKey } from '#universal/feature-flags/registry.ts'

import {
	type JevSearchRerankOutcome,
	type SearchCandidate,
} from './search-types.ts'
import { type SearchIntent } from './understand-search-query.ts'

export type { JevSearchRerankOutcome }
export { jevSearchRerankFlagKey }

/** Cap skinny cards sent to Jev even when recall is wider. */
export const jevSearchCandidateCap = 40

/**
 * When the flag is on, plugins fetch at least this many hybrid candidates
 * (still Vectorize-capped at 100) before heuristic rerank + Jev.
 */
export const jevSearchWideRecallLimit = 50

/** Mean Jev confidence below this falls back to hybrid order. */
export const jevSearchMinMeanConfidence = 0.45

/**
 * Score rubric: 0 unrelated … 3 best primary match. Drop below "clearly
 * relevant" (2) unless that would empty the result set.
 */
export const jevSearchMinKeepScore = 1.5

export const jevSearchModel = 'typesafe/jev'

/**
 * Max Score questions per `AI.run`. `typesafe/jev` can omit answers when
 * one call asks for the full candidate cap at once.
 */
export const jevSearchScoreQuestionBatchSize = 8

/** Safe length for `errorReason` on fallback-error telemetry. */
const jevSearchErrorReasonMaxChars = 240

const jevSearchGatewayRequiredReason = 'ai-gateway-required-for-typesafe-jev'

const jevSearchIncompleteScoreAnswersReason = 'incomplete-score-answers'

export type JevSearchSkinnyCard = {
	index: number
	type: SearchCandidate['type']
	id: string
	title: string
	summary: string
	domain?: string
}

export type JevSearchTokenUsage = {
	inputTokens: number | null
	outputTokens: number | null
}

export type JevSearchRerankResult = {
	candidates: Array<SearchCandidate>
	outcome: JevSearchRerankOutcome
	durationMs: number
	candidatesBefore: number
	candidatesAfter: number
	droppedCount: number
	meanConfidence: number | null
	top1Type: SearchCandidate['type'] | null
	/** Present only when `outcome` is `fallback-error`. */
	errorReason?: string
	/** Present when the Jev stage ran or attempted. */
	model?: typeof jevSearchModel
	/** Score `AI.run` count (one per question batch). */
	aiCallCount?: number
	/** Summed Workers AI / Gateway usage across batches. */
	usage?: JevSearchTokenUsage
}

type JevScoreAnswer = {
	type?: string
	score?: number
	confidence?: number
}

type JevRunUsage = {
	input_tokens?: number
	output_tokens?: number
	prompt_tokens?: number
	completion_tokens?: number
	inputTokens?: number
	outputTokens?: number
	promptTokens?: number
	completionTokens?: number
	tokens_in?: number
	tokens_out?: number
}

type JevRunResponse = {
	answers?: Record<string, JevScoreAnswer>
	usage?: JevRunUsage
}

export type JevResultAnswersPresence = 'object' | 'missing' | 'other'

/** Binding/Gateway payload after known-envelope unwrap. */
export type JevNormalizedRunResponse = {
	payload: JevRunResponse
	rawTopLevelKeys: Array<string>
	resultAnswers: JevResultAnswersPresence
}

type JevRuntimeEnv = {
	AI?: Ai
	AI_GATEWAY_ID?: string
}

function oneLine(text: string, maxChars: number): string {
	const collapsed = text.replace(/\s+/g, ' ').trim()
	if (collapsed.length <= maxChars) return collapsed
	return `${collapsed.slice(0, Math.max(0, maxChars - 3)).trimEnd()}...`
}

export function buildJevSearchSkinnyCard(
	candidate: SearchCandidate,
	index: number,
): JevSearchSkinnyCard {
	const match = candidate.match
	let summary = ''
	if ('description' in match && typeof match.description === 'string') {
		summary = match.description
	} else if ('summary' in match && typeof match.summary === 'string') {
		summary = match.summary
	} else if (candidate.searchFields[0]) {
		summary = candidate.searchFields[0]
	}
	const domain =
		'domain' in match && typeof match.domain === 'string'
			? match.domain
			: undefined
	return {
		index,
		type: candidate.type,
		id: candidate.id,
		title: oneLine(candidate.title, 80),
		summary: oneLine(summary, 160),
		...(domain ? { domain: oneLine(domain, 64) } : {}),
	}
}

export function resolveJevSearchRecallLimit(input: {
	limit: number
	widerRecall: boolean
}): number {
	if (!input.widerRecall) return Math.max(1, input.limit)
	return Math.max(input.limit, jevSearchWideRecallLimit)
}

function questionKey(index: number): string {
	return `c${String(index)}`
}

function asPlainRecord(value: unknown): Record<string, unknown> | null {
	if (value == null || typeof value !== 'object' || Array.isArray(value)) {
		return null
	}
	return value as Record<string, unknown>
}

function parseJsonRecord(value: string): Record<string, unknown> | null {
	try {
		return asPlainRecord(JSON.parse(value) as unknown)
	} catch {
		return null
	}
}

function recordHasAnswers(value: Record<string, unknown>): boolean {
	return asPlainRecord(value.answers) != null
}

function nestedRecord(value: unknown): Record<string, unknown> | null {
	if (typeof value === 'string') return parseJsonRecord(value)
	return asPlainRecord(value)
}

function describeResultAnswers(
	raw: Record<string, unknown> | null,
): JevResultAnswersPresence {
	if (!raw || !('result' in raw)) return 'missing'
	const result = nestedRecord(raw.result)
	if (raw.result == null) return 'missing'
	if (!result) return 'other'
	if (!('answers' in result)) return 'missing'
	return asPlainRecord(result.answers) != null ? 'object' : 'other'
}

/**
 * `typesafe/jev` is not in the generated AiModels map. Direct docs show
 * `{ answers, usage }`, but the Workers AI binding through
 * `{ gateway: { id } }` can return the Cloudflare v4 / `/ai/run` envelope
 * (`{ success, result: { answers, usage } }`) or a `{ response }` wrap.
 * Unwrap those so merge and usage read the Score payload.
 */
function unwrapJevPayload(
	raw: Record<string, unknown>,
): Record<string, unknown> {
	if (recordHasAnswers(raw)) return raw

	const result = nestedRecord(raw.result)
	if (result) {
		if (recordHasAnswers(result)) return result
		const resultResponse = nestedRecord(result.response)
		if (resultResponse && recordHasAnswers(resultResponse)) {
			return resultResponse
		}
	}

	const response = nestedRecord(raw.response)
	if (response && recordHasAnswers(response)) return response

	return raw
}

export function normalizeJevRunResponse(
	raw: unknown,
): JevNormalizedRunResponse {
	const parsedRaw =
		typeof raw === 'string' ? parseJsonRecord(raw) : asPlainRecord(raw)
	const rawTopLevelKeys = parsedRaw ? Object.keys(parsedRaw) : []
	const resultAnswers = describeResultAnswers(parsedRaw)
	if (!parsedRaw) {
		return { payload: {}, rawTopLevelKeys, resultAnswers }
	}
	const unwrapped = unwrapJevPayload(parsedRaw)
	const answers = asPlainRecord(unwrapped.answers)
	const usage = asPlainRecord(unwrapped.usage) ?? asPlainRecord(parsedRaw.usage)
	return {
		payload: {
			...(answers
				? { answers: answers as Record<string, JevScoreAnswer> }
				: {}),
			...(usage ? { usage: usage as JevRunUsage } : {}),
		},
		rawTopLevelKeys,
		resultAnswers,
	}
}

function buildQuestionBatches(
	cardCount: number,
	batchSize: number,
): Array<Array<number>> {
	const batches: Array<Array<number>> = []
	for (let start = 0; start < cardCount; start += batchSize) {
		const batch: Array<number> = []
		const end = Math.min(cardCount, start + batchSize)
		for (let index = start; index < end; index += 1) {
			batch.push(index)
		}
		batches.push(batch)
	}
	return batches
}

function buildJevQuestions(indexes: ReadonlyArray<number>) {
	const questions: Record<
		string,
		{
			type: 'score'
			instructions: string
			criteria: Array<string>
		}
	> = {}
	for (const index of indexes) {
		questions[questionKey(index)] = {
			type: 'score',
			instructions: `How relevant is state.candidates[${String(index)}] to state.query for the agent's next hop (open detail or execute)? Use state.intent only as context.`,
			criteria: [
				'Unrelated or misleading for this query',
				'Tangentially related',
				'Clearly relevant next hop',
				'Best primary match for this query',
			],
		}
	}
	return questions
}

async function runJevScoreRequest(
	runtime: JevRuntimeEnv & { AI: Ai },
	body: {
		state: Record<string, unknown>
		questions: ReturnType<typeof buildJevQuestions>
	},
	options?: { gateway: { id: string } },
	tally?: { aiCallCount: number },
): Promise<JevNormalizedRunResponse> {
	if (tally) tally.aiCallCount += 1
	// Model is not yet in the generated AiModels map; cast at the boundary.
	const raw: unknown = await runtime.AI.run(
		jevSearchModel as Parameters<Ai['run']>[0],
		body,
		options,
	)
	return normalizeJevRunResponse(raw)
}

function toJevErrorReason(error: unknown): string {
	return (
		oneLine(getErrorMessage(error), jevSearchErrorReasonMaxChars) ||
		'unknown-jev-error'
	)
}

async function runJevViaGateway(
	runtime: JevRuntimeEnv & { AI: Ai },
	body: {
		state: Record<string, unknown>
		questions: ReturnType<typeof buildJevQuestions>
	},
	tally?: { aiCallCount: number },
): Promise<JevNormalizedRunResponse> {
	const gatewayId = runtime.AI_GATEWAY_ID?.trim()
	if (!gatewayId) {
		throw new Error(jevSearchGatewayRequiredReason)
	}
	try {
		return await runJevScoreRequest(
			runtime,
			body,
			{
				gateway: { id: gatewayId },
			},
			tally,
		)
	} catch (error) {
		console.warn(
			JSON.stringify({
				message: 'Workers AI Gateway Jev request failed',
				gatewayId,
				error: getErrorMessage(error),
			}),
		)
		throw error
	}
}

function isCompleteScoreAnswer(
	answer: JevScoreAnswer | undefined,
): answer is JevScoreAnswer & { score: number; confidence: number } {
	return (
		answer != null &&
		typeof answer.score === 'number' &&
		Number.isFinite(answer.score) &&
		typeof answer.confidence === 'number' &&
		Number.isFinite(answer.confidence)
	)
}

function mergeScoreAnswers(
	responses: ReadonlyArray<JevRunResponse>,
): Record<string, JevScoreAnswer> {
	const answers: Record<string, JevScoreAnswer> = {}
	for (const response of responses) {
		if (!response.answers || typeof response.answers !== 'object') continue
		for (const [key, value] of Object.entries(response.answers)) {
			if (value) answers[key] = value
		}
	}
	return answers
}

function parseScoreAnswers(
	answers: Record<string, JevScoreAnswer>,
	cardCount: number,
):
	| {
			ok: true
			scores: Array<number>
			confidences: Array<number>
	  }
	| {
			ok: false
			expected: number
			received: number
	  } {
	const scores: Array<number> = []
	const confidences: Array<number> = []
	let received = 0
	for (let index = 0; index < cardCount; index += 1) {
		const answer = answers[questionKey(index)]
		if (!isCompleteScoreAnswer(answer)) continue
		received += 1
		scores.push(answer.score)
		confidences.push(answer.confidence)
	}
	if (received !== cardCount) {
		return { ok: false, expected: cardCount, received }
	}
	return { ok: true, scores, confidences }
}

function formatSampledKeys(keys: ReadonlyArray<string>): string {
	if (keys.length === 0) return 'none'
	const shown = keys.slice(0, 8)
	if (shown.length === keys.length) return shown.join(',')
	return `${shown.join(',')}+${String(keys.length - shown.length)}`
}

function incompleteScoreAnswersReason(input: {
	expected: number
	received: number
	rawTopLevelKeys: ReadonlyArray<string>
	resultAnswers: JevResultAnswersPresence
	answerKeys: ReadonlyArray<string>
}): string {
	return oneLine(
		[
			jevSearchIncompleteScoreAnswersReason,
			`expected=${String(input.expected)}`,
			`received=${String(input.received)}`,
			`keys=${formatSampledKeys(input.rawTopLevelKeys)}`,
			`result.answers=${input.resultAnswers}`,
			`answerKeys=${formatSampledKeys(input.answerKeys)}`,
		].join(' '),
		jevSearchErrorReasonMaxChars,
	)
}

function readFiniteTokenCount(value: unknown): number | null {
	return typeof value === 'number' && Number.isFinite(value) && value >= 0
		? value
		: null
}

function readResponseUsage(response: JevRunResponse): JevSearchTokenUsage {
	const usage = response.usage
	if (!usage || typeof usage !== 'object') {
		return { inputTokens: null, outputTokens: null }
	}
	return {
		inputTokens:
			readFiniteTokenCount(usage.input_tokens) ??
			readFiniteTokenCount(usage.prompt_tokens) ??
			readFiniteTokenCount(usage.inputTokens) ??
			readFiniteTokenCount(usage.promptTokens) ??
			readFiniteTokenCount(usage.tokens_in),
		outputTokens:
			readFiniteTokenCount(usage.output_tokens) ??
			readFiniteTokenCount(usage.completion_tokens) ??
			readFiniteTokenCount(usage.outputTokens) ??
			readFiniteTokenCount(usage.completionTokens) ??
			readFiniteTokenCount(usage.tokens_out),
	}
}

function sumTokenUsage(
	usages: ReadonlyArray<JevSearchTokenUsage>,
): JevSearchTokenUsage {
	let inputTokens: number | null = null
	let outputTokens: number | null = null
	for (const usage of usages) {
		if (usage.inputTokens != null) {
			inputTokens = (inputTokens ?? 0) + usage.inputTokens
		}
		if (usage.outputTokens != null) {
			outputTokens = (outputTokens ?? 0) + usage.outputTokens
		}
	}
	return { inputTokens, outputTokens }
}

function mean(values: ReadonlyArray<number>): number {
	if (values.length === 0) return 0
	let total = 0
	for (const value of values) total += value
	return total / values.length
}

/**
 * Reorder and drop hybrid candidates with Jev Score. Never returns an empty
 * list when `candidates` was non-empty — falls back to hybrid order instead.
 */
export async function rerankSearchCandidatesWithJev(input: {
	env: Env
	query: string
	intent: SearchIntent
	candidates: Array<SearchCandidate>
	limit: number
	offline: boolean
	enabled: boolean
}): Promise<JevSearchRerankResult> {
	const startedAt = performance.now()
	const hybridCandidates = input.candidates
	const candidatesBefore = hybridCandidates.length

	const emptyResult = (
		outcome: JevSearchRerankOutcome,
		extras?: {
			meanConfidence?: number | null
			errorReason?: string
			model?: typeof jevSearchModel
			aiCallCount?: number
			usage?: JevSearchTokenUsage
		},
	): JevSearchRerankResult => ({
		candidates: hybridCandidates.slice(0, Math.max(1, input.limit)),
		outcome,
		durationMs: performance.now() - startedAt,
		candidatesBefore,
		candidatesAfter: Math.min(candidatesBefore, Math.max(0, input.limit)),
		droppedCount: 0,
		meanConfidence: extras?.meanConfidence ?? null,
		top1Type: hybridCandidates[0]?.type ?? null,
		...(extras?.errorReason ? { errorReason: extras.errorReason } : {}),
		...(extras?.model
			? {
					model: extras.model,
					aiCallCount: extras.aiCallCount ?? 0,
					usage: extras.usage ?? {
						inputTokens: null,
						outputTokens: null,
					},
				}
			: {}),
	})

	if (!input.enabled) return emptyResult('skipped-flag-off')
	const attempted = {
		model: jevSearchModel,
		aiCallCount: 0,
		usage: { inputTokens: null, outputTokens: null },
	} as const
	if (candidatesBefore === 0) return emptyResult('skipped-empty', attempted)
	if (input.offline) return emptyResult('skipped-offline', attempted)

	const runtime = input.env as unknown as JevRuntimeEnv
	if (!runtime.AI) return emptyResult('skipped-no-ai', attempted)

	const pool = hybridCandidates.slice(0, jevSearchCandidateCap)
	const cards = pool.map((candidate, index) =>
		buildJevSearchSkinnyCard(candidate, index),
	)

	const tally = { aiCallCount: 0 }
	try {
		const state = {
			query: input.query,
			intent: {
				task: input.intent.task.name,
				confidence: input.intent.confidence,
				normalizedQuery: input.intent.normalizedQuery,
			},
			candidates: cards,
		}
		const batches = buildQuestionBatches(
			cards.length,
			jevSearchScoreQuestionBatchSize,
		)
		const responses = await Promise.all(
			batches.map((indexes) =>
				runJevViaGateway(
					runtime as JevRuntimeEnv & { AI: Ai },
					{
						state,
						questions: buildJevQuestions(indexes),
					},
					tally,
				),
			),
		)
		const usage = sumTokenUsage(
			responses.map((response) => readResponseUsage(response.payload)),
		)
		const mergedAnswers = mergeScoreAnswers(
			responses.map((response) => response.payload),
		)
		const parsed = parseScoreAnswers(mergedAnswers, cards.length)
		if (!parsed.ok) {
			const sample =
				responses.find((response) => {
					const answers = asPlainRecord(response.payload.answers)
					return answers == null || Object.keys(answers).length === 0
				}) ?? responses[0]
			return emptyResult('fallback-error', {
				errorReason: incompleteScoreAnswersReason({
					...parsed,
					rawTopLevelKeys: sample?.rawTopLevelKeys ?? [],
					resultAnswers: sample?.resultAnswers ?? 'missing',
					answerKeys: Object.keys(mergedAnswers),
				}),
				model: jevSearchModel,
				aiCallCount: tally.aiCallCount,
				usage,
			})
		}
		const meanConfidence = mean(parsed.confidences)
		if (meanConfidence < jevSearchMinMeanConfidence) {
			return emptyResult('fallback-low-confidence', {
				meanConfidence,
				model: jevSearchModel,
				aiCallCount: tally.aiCallCount,
				usage,
			})
		}

		const ranked = pool
			.map((candidate, index) => ({
				candidate,
				score: parsed.scores[index]!,
				confidence: parsed.confidences[index]!,
			}))
			.sort((left, right) => {
				const scoreDiff = right.score - left.score
				if (scoreDiff !== 0) return scoreDiff
				return right.confidence - left.confidence
			})

		const kept = ranked.filter((entry) => entry.score >= jevSearchMinKeepScore)
		if (kept.length === 0) {
			// Every score missed the keep threshold — preserve pre-Jev hybrid
			// order rather than returning the rejected Jev sort.
			return emptyResult('fallback-empty-after-drop', {
				meanConfidence,
				model: jevSearchModel,
				aiCallCount: tally.aiCallCount,
				usage,
			})
		}
		const candidates = kept
			.slice(0, Math.max(1, input.limit))
			.map((entry) => entry.candidate)
		return {
			candidates,
			outcome: 'applied',
			durationMs: performance.now() - startedAt,
			candidatesBefore,
			candidatesAfter: candidates.length,
			droppedCount: Math.max(0, pool.length - kept.length),
			meanConfidence,
			top1Type: candidates[0]?.type ?? null,
			model: jevSearchModel,
			aiCallCount: tally.aiCallCount,
			usage,
		}
	} catch (error) {
		console.warn(
			JSON.stringify({
				message: 'Jev search rerank failed; using hybrid order',
				error: getErrorMessage(error),
			}),
		)
		return emptyResult('fallback-error', {
			errorReason: toJevErrorReason(error),
			model: jevSearchModel,
			aiCallCount: tally.aiCallCount,
			usage: { inputTokens: null, outputTokens: null },
		})
	}
}
