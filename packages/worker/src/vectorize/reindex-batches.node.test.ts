import { expect, test, vi } from 'vitest'

const mockModule = vi.hoisted(() => ({
	embedTextsForVectorize: vi.fn(),
}))

vi.mock('./embedding.ts', () => ({
	embedTextsForVectorize: (...args: Array<unknown>) =>
		mockModule.embedTextsForVectorize(...args),
}))

const { reindexVectorCandidates } = await import('./reindex-batches.ts')

test('reindexVectorCandidates isolates failed embedding items and upserts the rest', async () => {
	mockModule.embedTextsForVectorize.mockReset()
	const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
	const upsert = vi.fn()
	const env = {} as Env
	mockModule.embedTextsForVectorize.mockImplementation(
		async (_env: Env, texts: Array<string>) => {
			if (texts.includes('bad')) throw new Error('embedding input rejected')
			return texts.map((text) => [text.length])
		},
	)

	try {
		await expect(
			reindexVectorCandidates({
				env,
				index: { upsert } as unknown as VectorizeIndex,
				kind: 'test',
				candidates: [
					{
						id: 'good-1',
						text: 'alpha',
						namespace: 'user-a',
						metadata: { kind: 'test' },
					},
					{
						id: 'bad-1',
						text: 'bad',
						namespace: 'user-a',
						metadata: { kind: 'test' },
					},
					{
						id: 'good-2',
						text: 'beta',
						namespace: 'user-b',
						metadata: { kind: 'test' },
					},
				],
			}),
		).resolves.toEqual({
			upserted: 2,
			failed: 1,
			failures: [
				{
					id: 'bad-1',
					phase: 'embed',
					error: 'embedding input rejected',
				},
			],
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
	} finally {
		consoleError.mockRestore()
	}
})

test('reindexVectorCandidates marks a phase fatal when every vector fails', async () => {
	mockModule.embedTextsForVectorize.mockReset()
	const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
	const env = {} as Env
	mockModule.embedTextsForVectorize.mockRejectedValue(new Error('ai down'))

	try {
		await expect(
			reindexVectorCandidates({
				env,
				index: { upsert: vi.fn() } as unknown as VectorizeIndex,
				kind: 'test',
				candidates: [
					{
						id: 'bad-1',
						text: 'alpha',
						namespace: 'user-a',
						metadata: { kind: 'test' },
					},
					{
						id: 'bad-2',
						text: 'beta',
						namespace: 'user-b',
						metadata: { kind: 'test' },
					},
				],
			}),
		).resolves.toMatchObject({
			upserted: 0,
			failed: 2,
			error: '2 test vector(s) failed to reindex',
		})
	} finally {
		consoleError.mockRestore()
	}
})
