/**
 * Small Jev eval slice for ranked search responses.
 *
 * Exposed only to admins or callers with `jev-search-rerank` on so agents can
 * verify whether stage-2 ran without shipping full search telemetry to every
 * client. Analytics Engine still records the same fields for all callers.
 */

import { type JevSearchRerankOutcome } from './search-types.ts'

export type JevSearchEvalTelemetry = {
	enabled: boolean
	outcome: JevSearchRerankOutcome
	candidatesBefore: number
	candidatesAfter: number
	droppedCount: number
	meanConfidence: number | null
	top1Type: string | null
	jevRerankMs?: number
}

export function shouldExposeJevSearchEvalTelemetry(input: {
	isAdmin: boolean
	jevRerankEnabled: boolean
}): boolean {
	return input.isAdmin || input.jevRerankEnabled
}

export function pickJevSearchEvalTelemetry(input: {
	jevRerank?: {
		enabled: boolean
		outcome: JevSearchRerankOutcome
		candidatesBefore: number
		candidatesAfter: number
		droppedCount: number
		meanConfidence: number | null
		top1Type: string | null
	}
	jevRerankMs?: number
}): JevSearchEvalTelemetry | null {
	const jevRerank = input.jevRerank
	if (!jevRerank) return null
	return {
		enabled: jevRerank.enabled,
		outcome: jevRerank.outcome,
		candidatesBefore: jevRerank.candidatesBefore,
		candidatesAfter: jevRerank.candidatesAfter,
		droppedCount: jevRerank.droppedCount,
		meanConfidence: jevRerank.meanConfidence,
		top1Type: jevRerank.top1Type,
		...(typeof input.jevRerankMs === 'number'
			? { jevRerankMs: input.jevRerankMs }
			: {}),
	}
}
