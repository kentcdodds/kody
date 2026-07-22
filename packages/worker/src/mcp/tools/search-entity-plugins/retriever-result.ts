import { lexicalScore } from '#mcp/capabilities/capability-search.ts'

import { type SearchEntityPlugin } from '../search-entity-plugin.ts'
import { buildCandidateBaseScore } from '../search-scoring.ts'

export const retrieverResultSearchEntityPlugin = {
	type: 'retriever_result',
	buildCandidates(input) {
		return input.retrieverResults
			.map((result) => {
				const lexical = lexicalScore(
					input.query,
					[
						result.title,
						result.summary,
						result.details ?? '',
						result.source ?? '',
						result.kodyId,
						result.retrieverName,
					].join('\n'),
				)
				const score = Math.min(1, Math.max(0, result.score ?? 0))
				return {
					match: {
						type: 'retriever_result' as const,
						...result,
					},
					type: 'retriever_result' as const,
					id: `${result.kodyId}:${result.retrieverKey}:${result.id}`,
					title: result.title,
					searchFields: [
						result.title,
						result.summary,
						result.details ?? '',
						result.source ?? '',
						result.kodyId,
						result.retrieverName,
					],
					scoreComponents: buildCandidateBaseScore({
						lexical: Math.max(lexical, score),
					}),
				}
			})
			.filter((candidate) => candidate.scoreComponents.base > 0)
	},
	formatSlimMatch({ match }) {
		return {
			type: 'retriever_result',
			id: match.id,
			title: match.title,
			summary: match.summary,
			details: match.details ?? null,
			source: match.source ?? `${match.kodyId}/${match.retrieverKey}`,
			url: match.url ?? null,
			score: match.score ?? null,
			packageId: match.packageId,
			kodyId: match.kodyId,
			retrieverKey: match.retrieverKey,
			retrieverName: match.retrieverName,
		}
	},
} satisfies SearchEntityPlugin<'retriever_result'>
