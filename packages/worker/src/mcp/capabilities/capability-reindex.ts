import {
	buildCapabilityEmbedText,
	embedTextsForVectorize,
	getCapabilityVectorIndex,
} from './capability-search.ts'
import { type CapabilitySpec } from './types.ts'

const upsertBatchSize = 16

export async function reindexCapabilityVectors(
	env: Env,
	specs: Record<string, CapabilitySpec>,
): Promise<{ upserted: number }> {
	const index = getCapabilityVectorIndex(env)
	if (!index) {
		throw new Error('CAPABILITY_VECTOR_INDEX binding is not configured')
	}

	const list = Object.values(specs)
	let upserted = 0

	for (let offset = 0; offset < list.length; offset += upsertBatchSize) {
		const batch = list.slice(offset, offset + upsertBatchSize)
		const texts = batch.map((spec) => buildCapabilityEmbedText(spec))
		const rows = await embedTextsForVectorize(env, texts)

		const vectors = batch.map((spec, index_) => ({
			id: spec.name,
			values: rows[index_]!,
			metadata: { domain: spec.domain, kind: 'builtin' },
		}))

		await index.upsert(vectors)
		upserted += vectors.length
	}

	return { upserted }
}
