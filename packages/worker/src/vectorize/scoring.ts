/**
 * Corpus-agnostic ranking primitives shared by capability search, package
 * search, memory search, and community search. Lives outside `#mcp/*` so
 * non-MCP subsystems can rank hybrid lexical/vector results without importing
 * from the MCP layer.
 */

export const CAPABILITY_SEARCH_RRF_K = 60

export function tokenizeSearchText(value: string): Set<string> {
	return new Set(value.toLowerCase().match(/[a-z0-9]+/g) ?? [])
}

export function lexicalScore(query: string, doc: string): number {
	const q = tokenizeSearchText(query)
	const d = tokenizeSearchText(doc)
	if (q.size === 0) return 0
	let intersection = 0
	for (const t of q) {
		if (d.has(t)) intersection += 1
	}
	return intersection / q.size
}

export function cosineSimilarity(
	a: ReadonlyArray<number>,
	b: ReadonlyArray<number>,
): number {
	let dot = 0
	for (let i = 0; i < a.length; i += 1) dot += a[i]! * b[i]!
	return dot
}

// Keep hybrid lexical+vector scores on the same scale as lexical-only matches.
export function blendLexicalAndVectorScore(lexical: number, vector: number) {
	return (lexical + Math.max(0, vector)) / 2
}

export function reciprocalRankFusion(
	rankedLists: Array<Array<string>>,
	k: number,
): Map<string, number> {
	const scores = new Map<string, number>()
	for (const list of rankedLists) {
		for (let rank = 0; rank < list.length; rank += 1) {
			const id = list[rank]!
			scores.set(id, (scores.get(id) ?? 0) + 1 / (k + rank + 1))
		}
	}
	return scores
}

export function sortIdsByScore(
	ids: ReadonlyArray<string>,
	scoreFn: (id: string) => number,
): Array<string> {
	return [...ids].sort((a, b) => scoreFn(b) - scoreFn(a))
}
