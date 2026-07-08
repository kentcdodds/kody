import { getErrorMessage } from '@kody-internal/shared/error-message.ts'
import { embedTextsForVectorize } from './capability-search.ts'

export type VectorReindexFailurePhase = 'load' | 'embed' | 'upsert'

export type VectorReindexFailure = {
	id: string
	phase: VectorReindexFailurePhase
	error: string
}

export type VectorReindexCandidate = {
	id: string
	text: string
	metadata: Record<string, VectorizeVectorMetadata>
}

export type VectorReindexResult = {
	upserted: number
	failed?: number
	warning?: string
	error?: string
	failures?: Array<VectorReindexFailure>
}

const upsertBatchSize = 16
const maxReportedFailures = 20

export async function reindexVectorCandidates(input: {
	env: Env
	index: VectorizeIndex
	kind: string
	candidates: ReadonlyArray<VectorReindexCandidate>
}): Promise<VectorReindexResult> {
	let upserted = 0
	let failed = 0
	const failures: Array<VectorReindexFailure> = []

	function recordFailure(input_: {
		candidate: VectorReindexCandidate
		phase: VectorReindexFailurePhase
		error: unknown
	}) {
		failed += 1
		const failure = {
			id: input_.candidate.id,
			phase: input_.phase,
			error: getErrorMessage(input_.error),
		}
		if (failures.length < maxReportedFailures) failures.push(failure)
		console.error(
			JSON.stringify({
				message: 'capability vector reindex skipped vector',
				kind: input.kind,
				vectorId: input_.candidate.id,
				phase: input_.phase,
				error: failure.error,
			}),
		)
	}

	async function splitOrRecord(
		batch: ReadonlyArray<VectorReindexCandidate>,
		phase: VectorReindexFailurePhase,
		error: unknown,
	) {
		if (batch.length === 1) {
			recordFailure({ candidate: batch[0]!, phase, error })
			return
		}
		const midpoint = Math.ceil(batch.length / 2)
		await processBatch(batch.slice(0, midpoint))
		await processBatch(batch.slice(midpoint))
	}

	async function processBatch(batch: ReadonlyArray<VectorReindexCandidate>) {
		let embeddings: Array<Array<number>>
		try {
			embeddings = await embedTextsForVectorize(
				input.env,
				batch.map((candidate) => candidate.text),
			)
		} catch (error) {
			await splitOrRecord(batch, 'embed', error)
			return
		}

		try {
			await input.index.upsert(
				batch.map((candidate, index_) => ({
					id: candidate.id,
					values: embeddings[index_]!,
					metadata: candidate.metadata,
				})),
			)
			upserted += batch.length
		} catch (error) {
			await splitOrRecord(batch, 'upsert', error)
		}
	}

	for (
		let offset = 0;
		offset < input.candidates.length;
		offset += upsertBatchSize
	) {
		await processBatch(input.candidates.slice(offset, offset + upsertBatchSize))
	}

	if (failed === 0) return { upserted }

	const result: VectorReindexResult = {
		upserted,
		failed,
		failures,
	}
	const message = `${failed} ${input.kind} vector(s) failed to reindex`
	if (upserted === 0 && input.candidates.length > 0) {
		result.error = message
	} else {
		result.warning = message
	}
	return result
}
