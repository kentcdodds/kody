/**
 * Stable user ids are lowercase SHA-256 hex strings. This reserved value
 * contains non-hex characters, so it cannot collide with an account namespace.
 */
export const BUILTIN_VECTOR_NAMESPACE = '__kody_builtin__'

export function userVectorNamespace(userId: string): string {
	return userId
}

/**
 * Expand-phase read path for the namespace migration. Queries both the new
 * namespace and the legacy default namespace so partially reindexed users keep
 * complete results. Metadata filters stay identical on both reads.
 *
 * Remove this fallback after production's full capability reindex reports that
 * every user-owned vector was upserted into its user namespace.
 */
export async function queryVectorizeWithNamespaceFallback(input: {
	index: VectorizeIndex
	vector: ReadonlyArray<number>
	namespace: string
	options: VectorizeQueryOptions
}): Promise<VectorizeMatches> {
	const queryOptions = { ...input.options }
	delete queryOptions.namespace
	const [namespacedMatches, legacyMatches] = await Promise.all([
		input.index.query([...input.vector], {
			...queryOptions,
			namespace: input.namespace,
		}),
		input.index.query([...input.vector], queryOptions),
	])
	const matchById = new Map<string, VectorizeMatch>()
	for (const match of [
		...namespacedMatches.matches,
		...legacyMatches.matches,
	]) {
		const existing = matchById.get(match.id)
		if (!existing || match.score > existing.score) {
			matchById.set(match.id, match)
		}
	}
	const topK =
		queryOptions.topK ??
		Math.max(namespacedMatches.matches.length, legacyMatches.matches.length)
	const matches = [...matchById.values()]
		.sort((left, right) => right.score - left.score)
		.slice(0, topK)
	return { matches, count: matches.length }
}
