/**
 * Stable user ids are lowercase SHA-256 hex strings. This reserved value
 * contains non-hex characters, so it cannot collide with an account namespace.
 */
export const BUILTIN_VECTOR_NAMESPACE = '__kody_builtin__'

export function userVectorNamespace(userId: string): string {
	return userId
}

/**
 * Expand-phase read path for the namespace migration. New vectors are queried
 * first; the legacy default namespace is consulted only when the new namespace
 * has no matches. Metadata filters stay identical on both reads.
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
	const namespacedMatches = await input.index.query([...input.vector], {
		...input.options,
		namespace: input.namespace,
	})
	if (namespacedMatches.matches.length > 0) return namespacedMatches
	return input.index.query([...input.vector], input.options)
}
