import { expect, test, vi } from 'vitest'

const mockModule = vi.hoisted(() => ({
	embedTextsForVectorize: vi.fn(),
}))

vi.mock('./embedding.ts', () => ({
	embedTextsForVectorize: (...args: Array<unknown>) =>
		mockModule.embedTextsForVectorize(...args),
}))

const { reindexVectorCandidates } = await import('./reindex-batches.ts')

function candidate(id: string, text: string, namespace = 'user-a') {
	return { id, text, namespace, metadata: { kind: 'test' } }
}

function reindex(
	candidates: Array<ReturnType<typeof candidate>>,
	upsert = vi.fn(),
) {
	return reindexVectorCandidates({
		env: {} as Env,
		index: { upsert } as unknown as VectorizeIndex,
		kind: 'test',
		candidates,
	})
}

test('reindexVectorCandidates isolates failed embedding items and upserts the rest', async () => {
	const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
	const upsert = vi.fn()
	mockModule.embedTextsForVectorize.mockImplementation(
		async (_env: Env, texts: Array<string>) => {
			if (texts.includes('bad')) throw new Error('embedding input rejected')
			return texts.map((text) => [text.length])
		},
	)

	await expect(
		reindex(
			[
				candidate('good-1', 'alpha'),
				candidate('bad-1', 'bad'),
				candidate('good-2', 'beta', 'user-b'),
			],
			upsert,
		),
	).resolves.toEqual({
		upserted: 2,
		failed: 1,
		failures: [
			{ id: 'bad-1', phase: 'embed', error: 'embedding input rejected' },
		],
		failedIds: ['bad-1'],
		warning: '1 test vector(s) failed to reindex',
	})
	expect(upsert).toHaveBeenCalledWith([
		{
			id: 'good-1',
			values: [5],
			namespace: 'user-a',
			metadata: { kind: 'test' },
		},
	])
	expect(upsert).toHaveBeenCalledWith([
		{
			id: 'good-2',
			values: [4],
			namespace: 'user-b',
			metadata: { kind: 'test' },
		},
	])
	expect(consoleError).toHaveBeenCalledWith(
		expect.stringContaining('capability vector reindex skipped vector'),
	)
	consoleError.mockRestore()
})

test('reindexVectorCandidates keeps uncapped failedIds beyond the failure sample cap and marks all-failed phases fatal', async () => {
	const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
	mockModule.embedTextsForVectorize.mockRejectedValue(new Error('ai down'))
	const candidates = Array.from({ length: 25 }, (_, index) =>
		candidate(`bad-${index}`, `text-${index}`),
	)

	const result = await reindex(candidates)
	expect(result.failed).toBe(25)
	expect(result.failures).toHaveLength(20)
	expect(result.failedIds).toEqual(candidates.map(({ id }) => id))

	await expect(
		reindex([
			candidate('bad-1', 'alpha'),
			candidate('bad-2', 'beta', 'user-b'),
		]),
	).resolves.toMatchObject({
		upserted: 0,
		failed: 2,
		error: '2 test vector(s) failed to reindex',
	})
	consoleError.mockRestore()
})
