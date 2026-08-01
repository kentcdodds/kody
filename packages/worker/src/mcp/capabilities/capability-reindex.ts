import { buildCapabilityEmbedText } from './capability-search.ts'
import { getCapabilityVectorIndex } from '#worker/vectorize/embedding.ts'
import {
	reindexVectorCandidates,
	type VectorReindexResult,
} from '#worker/vectorize/reindex-batches.ts'
import { BUILTIN_VECTOR_NAMESPACE } from '#worker/vectorize/vector-namespaces.ts'
import { type CapabilitySpec } from './types.ts'

export async function reindexCapabilityVectors(
	env: Env,
	specs: Record<string, CapabilitySpec>,
): Promise<VectorReindexResult> {
	const index = getCapabilityVectorIndex(env)
	if (!index) {
		throw new Error('CAPABILITY_VECTOR_INDEX binding is not configured')
	}

	return reindexVectorCandidates({
		env,
		index,
		kind: 'builtin capability',
		candidates: Object.values(specs).map((spec) => ({
			id: spec.name,
			text: buildCapabilityEmbedText(spec),
			namespace: BUILTIN_VECTOR_NAMESPACE,
			metadata: { domain: spec.domain, kind: 'builtin' },
		})),
	})
}
