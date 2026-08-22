import {
	mergeVectorReindexResults,
	reindexVectorCandidates,
	vectorReindexUpsertBatchSize,
	type VectorReindexCandidate,
	type VectorReindexResult,
} from './reindex-batches.ts'

export const capabilityReindexPhases = [
	'capabilities',
	'memories',
	'jobs',
	'packages',
] as const

export type CapabilityReindexPhase = (typeof capabilityReindexPhases)[number]

export type CapabilityReindexCursor = {
	phase: CapabilityReindexPhase
	afterId: string | null
}

export type VectorReindexSweepOptions = {
	afterId?: string | null
	deadlineMs?: number
	force?: boolean
}

export type VectorReindexSweepResult = VectorReindexResult & {
	complete: boolean
	afterId: string | null
}

/**
 * Wall-clock budget for one `/__maintenance/reindex-capabilities` request.
 * Production CI curls with a 120s limit; this leaves headroom to return a
 * cursor instead of hanging until the client times out.
 */
export const capabilityReindexTimeBudgetMs = 70_000

export function hasReachedReindexDeadline(deadlineMs?: number) {
	return deadlineMs !== undefined && Date.now() >= deadlineMs
}

export function isCapabilityReindexPhase(
	value: unknown,
): value is CapabilityReindexPhase {
	return (
		typeof value === 'string' &&
		(capabilityReindexPhases as ReadonlyArray<string>).includes(value)
	)
}

/**
 * Resolve the optional `phases` body field. Omitted `phases` means every
 * kind (disaster recovery / embedding-model rebuild). Requested phases are
 * returned in canonical order.
 */
export function resolveCapabilityReindexPhases(
	value: unknown,
):
	| { ok: true; phases: ReadonlyArray<CapabilityReindexPhase> }
	| { ok: false; error: string } {
	if (value === undefined) {
		return { ok: true, phases: capabilityReindexPhases }
	}
	if (!Array.isArray(value) || value.length === 0) {
		return { ok: false, error: 'phases must be a non-empty array.' }
	}
	const seen = new Set<CapabilityReindexPhase>()
	for (const item of value) {
		if (!isCapabilityReindexPhase(item)) {
			return {
				ok: false,
				error:
					'phases must contain only capabilities, memories, jobs, or packages.',
			}
		}
		if (seen.has(item)) {
			return { ok: false, error: 'phases must not contain duplicates.' }
		}
		seen.add(item)
	}
	return {
		ok: true,
		phases: capabilityReindexPhases.filter((phase) => seen.has(phase)),
	}
}

export function toVectorReindexSweepResult(
	result: VectorReindexResult,
	input: { complete: boolean; afterId: string | null },
): VectorReindexSweepResult {
	return {
		...result,
		complete: input.complete,
		afterId: input.afterId,
	}
}

export async function reindexVectorCandidateList(input: {
	env: Env
	index: VectorizeIndex
	kind: string
	candidates: ReadonlyArray<VectorReindexCandidate>
	afterId?: string | null
	deadlineMs?: number
	force?: boolean
}): Promise<VectorReindexSweepResult> {
	const startIndex = findResumeIndex(input.candidates, input.afterId)
	const pageResults: Array<VectorReindexResult> = []
	let afterId = input.afterId ?? null

	for (
		let offset = startIndex;
		offset < input.candidates.length;
		offset += vectorReindexUpsertBatchSize
	) {
		if (hasReachedReindexDeadline(input.deadlineMs) && pageResults.length > 0) {
			return toVectorReindexSweepResult(
				mergeVectorReindexResults(input.kind, pageResults),
				{ complete: false, afterId },
			)
		}
		const batch = input.candidates.slice(
			offset,
			offset + vectorReindexUpsertBatchSize,
		)
		pageResults.push(
			await reindexVectorCandidates({
				env: input.env,
				index: input.index,
				kind: input.kind,
				candidates: batch,
				force: input.force,
			}),
		)
		afterId = batch[batch.length - 1]!.id
	}

	return toVectorReindexSweepResult(
		mergeVectorReindexResults(input.kind, pageResults),
		{ complete: true, afterId: null },
	)
}

export async function reindexPagedVectorRows<Row>(input: {
	env: Env
	index: VectorizeIndex
	kind: string
	pageSize: number
	afterId?: string | null
	deadlineMs?: number
	force?: boolean
	listPage: (input: {
		afterId: string | null
		limit: number
	}) => Promise<Array<Row>>
	rowId: (row: Row) => string
	toCandidate: (row: Row) => VectorReindexCandidate | null
}): Promise<VectorReindexSweepResult> {
	const pageResults: Array<VectorReindexResult> = []
	let afterId = input.afterId ?? null

	while (true) {
		if (hasReachedReindexDeadline(input.deadlineMs) && pageResults.length > 0) {
			return toVectorReindexSweepResult(
				mergeVectorReindexResults(input.kind, pageResults),
				{ complete: false, afterId },
			)
		}

		const rows = await input.listPage({
			afterId,
			limit: input.pageSize,
		})
		if (rows.length === 0) {
			return toVectorReindexSweepResult(
				mergeVectorReindexResults(input.kind, pageResults),
				{ complete: true, afterId: null },
			)
		}

		for (
			let offset = 0;
			offset < rows.length;
			offset += vectorReindexUpsertBatchSize
		) {
			if (
				hasReachedReindexDeadline(input.deadlineMs) &&
				pageResults.length > 0
			) {
				return toVectorReindexSweepResult(
					mergeVectorReindexResults(input.kind, pageResults),
					{ complete: false, afterId },
				)
			}
			const chunk = rows.slice(offset, offset + vectorReindexUpsertBatchSize)
			const candidates = chunk.flatMap((row) => {
				const candidate = input.toCandidate(row)
				return candidate ? [candidate] : []
			})
			if (candidates.length > 0) {
				pageResults.push(
					await reindexVectorCandidates({
						env: input.env,
						index: input.index,
						kind: input.kind,
						candidates,
						force: input.force,
					}),
				)
			} else {
				pageResults.push({ upserted: 0 })
			}
			afterId = input.rowId(chunk[chunk.length - 1]!)
		}

		if (rows.length < input.pageSize) {
			return toVectorReindexSweepResult(
				mergeVectorReindexResults(input.kind, pageResults),
				{ complete: true, afterId: null },
			)
		}
	}
}

function findResumeIndex(
	candidates: ReadonlyArray<VectorReindexCandidate>,
	afterId: string | null | undefined,
) {
	if (afterId == null) return 0
	const index = candidates.findIndex((candidate) => candidate.id === afterId)
	return index === -1 ? 0 : index + 1
}
