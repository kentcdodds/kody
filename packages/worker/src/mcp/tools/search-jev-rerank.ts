/**
 * Stage-2 Jev Score rerank/filter for ranked MCP `search({ query })`.
 *
 * Hybrid lexical+vector recall stays the retriever. When the
 * `jev-search-rerank` flag is on, a wider candidate pool is scored by
 * Workers AI `typesafe/jev` through AI Gateway. That third-party model
 * requires Gateway authentication and Unified Billing (or BYOK); the
 * Worker does not fall back to direct Workers AI. Failures and low
 * confidence fall back to the pre-Jev hybrid order for the same pool.
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
}

type JevScoreAnswer = {
	type?: string
	score?: number
	confidence?: number
}

type JevRunResponse = {
	answers?: Record<string, JevScoreAnswer>
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

function buildJevQuestions(cardCount: number) {
	const questions: Record<
		string,
		{
			type: 'score'
			instructions: string
			criteria: Array<string>
		}
	> = {}
	for (let index = 0; index < cardCount; index += 1) {
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
): Promise<JevRunResponse> {
	// Model is not yet in the generated AiModels map; cast at the boundary.
	return (await runtime.AI.run(
		jevSearchModel as Parameters<Ai['run']>[0],
		body,
		options,
	)) as JevRunResponse
}

function toJevErrorReason(error: unknown): string {
	return oneLine(getErrorMessage(error), jevSearchErrorReasonMaxChars)
}

async function runJevViaGateway(
	runtime: JevRuntimeEnv & { AI: Ai },
	body: {
		state: Record<string, unknown>
		questions: ReturnType<typeof buildJevQuestions>
	},
): Promise<JevRunResponse> {
	const gatewayId = runtime.AI_GATEWAY_ID?.trim()
	if (!gatewayId) {
		throw new Error(jevSearchGatewayRequiredReason)
	}
	try {
		return await runJevScoreRequest(runtime, body, {
			gateway: { id: gatewayId },
		})
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

function parseScoreAnswers(
	response: JevRunResponse,
	cardCount: number,
): {
	scores: Array<number>
	confidences: Array<number>
} | null {
	const answers = response.answers
	if (!answers || typeof answers !== 'object') return null
	const scores: Array<number> = []
	const confidences: Array<number> = []
	for (let index = 0; index < cardCount; index += 1) {
		const answer = answers[questionKey(index)]
		if (
			!answer ||
			typeof answer.score !== 'number' ||
			!Number.isFinite(answer.score) ||
			typeof answer.confidence !== 'number' ||
			!Number.isFinite(answer.confidence)
		) {
			return null
		}
		scores.push(answer.score)
		confidences.push(answer.confidence)
	}
	return { scores, confidences }
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
	})

	if (!input.enabled) return emptyResult('skipped-flag-off')
	if (candidatesBefore === 0) return emptyResult('skipped-empty')
	if (input.offline) return emptyResult('skipped-offline')

	const runtime = input.env as unknown as JevRuntimeEnv
	if (!runtime.AI) return emptyResult('skipped-no-ai')

	const pool = hybridCandidates.slice(0, jevSearchCandidateCap)
	const cards = pool.map((candidate, index) =>
		buildJevSearchSkinnyCard(candidate, index),
	)

	try {
		const response = await runJevViaGateway(
			runtime as JevRuntimeEnv & { AI: Ai },
			{
				state: {
					query: input.query,
					intent: {
						task: input.intent.task.name,
						confidence: input.intent.confidence,
						normalizedQuery: input.intent.normalizedQuery,
					},
					candidates: cards,
				},
				questions: buildJevQuestions(cards.length),
			},
		)
		const parsed = parseScoreAnswers(response, cards.length)
		if (!parsed) {
			return emptyResult('fallback-error', {
				errorReason: jevSearchIncompleteScoreAnswersReason,
			})
		}
		const meanConfidence = mean(parsed.confidences)
		if (meanConfidence < jevSearchMinMeanConfidence) {
			return emptyResult('fallback-low-confidence', { meanConfidence })
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
			return emptyResult('fallback-empty-after-drop', { meanConfidence })
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
		})
	}
}
