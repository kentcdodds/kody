import { expect, test, vi } from 'vitest'
import { vectorReindexUpsertBatchSize } from './reindex-batches.ts'
import {
	reindexPagedVectorRows,
	reindexVectorCandidateList,
	resolveCapabilityReindexPhases,
} from './reindex-sweep.ts'

const mockModule = vi.hoisted(() => ({
	embedTextsForVectorize: vi.fn(),
}))

vi.mock('./embedding.ts', () => ({
	embedTextsForVectorize: (...args: Array<unknown>) =>
		mockModule.embedTextsForVectorize(...args),
}))

function candidate(id: string) {
	return { id, text: id, namespace: 'ns', metadata: { kind: 'test' } }
}

test('reindex sweep helpers page to a deadline and canonicalize capability phases', async () => {
	expect(
		[undefined, ['packages', 'capabilities'], []].map(
			resolveCapabilityReindexPhases,
		),
	).toEqual([
		{ ok: true, phases: ['capabilities', 'memories', 'jobs', 'packages'] },
		{ ok: true, phases: ['capabilities', 'packages'] },
		{ ok: false, error: 'phases must be a non-empty array.' },
	])

	mockModule.embedTextsForVectorize.mockImplementation(
		async (_env: unknown, texts: Array<string>) => texts.map(() => [0.1]),
	)
	const index = { upsert: vi.fn() } as unknown as VectorizeIndex
	const env = {} as Env
	const id = (prefix: string, n: number) =>
		`${prefix}-${String(n).padStart(2, '0')}`
	const candidates = Array.from(
		{ length: vectorReindexUpsertBatchSize + 2 },
		(_, n) => candidate(id('cap', n)),
	)

	const first = await reindexVectorCandidateList({
		env,
		index,
		kind: 'builtin capability',
		candidates,
		deadlineMs: 0,
	})
	expect(first).toEqual({
		upserted: vectorReindexUpsertBatchSize,
		complete: false,
		afterId: id('cap', vectorReindexUpsertBatchSize - 1),
	})

	const second = await reindexVectorCandidateList({
		env,
		index,
		kind: 'builtin capability',
		candidates,
		afterId: first.afterId,
	})
	expect(second).toEqual({ upserted: 2, complete: true, afterId: null })

	const rows = Array.from(
		{ length: vectorReindexUpsertBatchSize + 1 },
		(_, n) => ({ id: id('row', n) }),
	)
	const listed: Array<string | null> = []
	const pagedFirst = await reindexPagedVectorRows({
		env,
		index,
		kind: 'memory',
		pageSize: 200,
		deadlineMs: 0,
		listPage: async ({ afterId }) => {
			listed.push(afterId)
			return afterId == null ? rows : []
		},
		rowId: (row) => row.id,
		toCandidate: (row) => candidate(row.id),
	})
	expect(pagedFirst).toEqual({
		upserted: vectorReindexUpsertBatchSize,
		complete: false,
		afterId: id('row', vectorReindexUpsertBatchSize - 1),
	})
	expect(listed).toEqual([null])

	const pagedSecond = await reindexPagedVectorRows({
		env,
		index,
		kind: 'memory',
		pageSize: 200,
		afterId: pagedFirst.afterId,
		listPage: async ({ afterId }) => {
			if (afterId !== pagedFirst.afterId) return []
			return rows.slice(vectorReindexUpsertBatchSize)
		},
		rowId: (row) => row.id,
		toCandidate: (row) => candidate(row.id),
	})
	expect(pagedSecond).toEqual({ upserted: 1, complete: true, afterId: null })
})
