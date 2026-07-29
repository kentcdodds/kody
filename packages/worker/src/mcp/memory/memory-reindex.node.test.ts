import { expect, test, vi } from 'vitest'
import {
	d1LockRetryBaseDelayMs,
	d1LockRetryMaxAttempts,
} from '#worker/d1-retry.ts'
import { type McpMemoryRow } from './types.ts'

const mockModule = vi.hoisted(() => ({
	embedTextForVectorize: vi.fn(),
	embedTextsForVectorize: vi.fn(),
	getCapabilityVectorIndex: vi.fn(),
	isCapabilitySearchOffline: vi.fn(),
	listMemoriesPage: vi.fn(),
}))

vi.mock('#worker/vectorize/embedding.ts', () => ({
	embedTextForVectorize: (...args: Array<unknown>) =>
		mockModule.embedTextForVectorize(...args),
	embedTextsForVectorize: (...args: Array<unknown>) =>
		mockModule.embedTextsForVectorize(...args),
	getCapabilityVectorIndex: (...args: Array<unknown>) =>
		mockModule.getCapabilityVectorIndex(...args),
	isCapabilitySearchOffline: (...args: Array<unknown>) =>
		mockModule.isCapabilitySearchOffline(...args),
}))

vi.mock('./repo.ts', () => ({
	listMemoriesPage: (...args: Array<unknown>) =>
		mockModule.listMemoriesPage(...args),
}))

const { reindexMemoryVectors } = await import('./memory-reindex.ts')

function resetMocks() {
	mockModule.embedTextsForVectorize.mockReset()
	mockModule.getCapabilityVectorIndex.mockReset()
	mockModule.isCapabilitySearchOffline.mockReset()
	mockModule.listMemoriesPage.mockReset()
}

function buildMemoryRow(id: string): McpMemoryRow {
	return {
		id,
		user_id: `user-${id}`,
		category: null,
		status: 'active',
		subject: `Subject ${id}`,
		summary: `Summary ${id}`,
		details: '',
		tags_json: '[]',
		source_uris_json: '[]',
		dedupe_key: null,
		created_at: '2026-01-01T00:00:00.000Z',
		updated_at: '2026-01-01T00:00:00.000Z',
		last_accessed_at: null,
		deleted_at: null,
	}
}

test('memory reindex walks keyset pages and merges the page results', async () => {
	resetMocks()
	const upsert = vi.fn(async (_vectors: Array<{ id: string }>) => {})
	mockModule.getCapabilityVectorIndex.mockReturnValue({ upsert })
	mockModule.isCapabilitySearchOffline.mockReturnValue(false)
	mockModule.embedTextsForVectorize.mockImplementation(
		async (_env: unknown, texts: Array<string>) => texts.map(() => [0.1]),
	)
	// The first page fills the requested limit, forcing a second page fetch.
	mockModule.listMemoriesPage.mockImplementationOnce(
		async (input: { afterId: string | null; limit: number }) =>
			Array.from({ length: input.limit }, (_, index) =>
				buildMemoryRow(`memory-${String(index).padStart(4, '0')}`),
			),
	)
	mockModule.listMemoriesPage.mockImplementationOnce(async () => [
		buildMemoryRow('memory-last'),
	])

	await expect(reindexMemoryVectors({ APP_DB: {} } as Env)).resolves.toEqual({
		upserted: 201,
	})

	expect(mockModule.listMemoriesPage).toHaveBeenCalledTimes(2)
	expect(mockModule.listMemoriesPage).toHaveBeenNthCalledWith(1, {
		db: expect.anything(),
		afterId: null,
		limit: 200,
	})
	expect(mockModule.listMemoriesPage).toHaveBeenNthCalledWith(2, {
		db: expect.anything(),
		afterId: 'memory-0199',
		limit: 200,
	})
	const upsertedIds = upsert.mock.calls.flatMap(([vectors]) =>
		vectors.map((vector) => vector.id),
	)
	expect(upsertedIds).toHaveLength(201)
	expect(new Set(upsertedIds).size).toBe(201)
})

test('memory reindex retries transient D1 export page errors then surfaces exhaustion', async () => {
	resetMocks()
	const upsert = vi.fn()
	mockModule.getCapabilityVectorIndex.mockReturnValue({ upsert })
	mockModule.isCapabilitySearchOffline.mockReturnValue(false)
	mockModule.embedTextsForVectorize.mockResolvedValue([[0.1]])
	mockModule.listMemoriesPage.mockResolvedValueOnce([])
	await expect(reindexMemoryVectors({ APP_DB: {} } as Env)).resolves.toEqual({
		upserted: 0,
	})

	resetMocks()
	mockModule.getCapabilityVectorIndex.mockReturnValue({ upsert })
	mockModule.isCapabilitySearchOffline.mockReturnValue(false)
	mockModule.embedTextsForVectorize.mockResolvedValue([[0.1]])
	mockModule.listMemoriesPage
		.mockRejectedValueOnce(
			new Error('D1_ERROR: Currently processing a long-running export.'),
		)
		.mockResolvedValueOnce([buildMemoryRow('memory-1')])

	vi.useFakeTimers()
	try {
		const recoverPromise = reindexMemoryVectors({ APP_DB: {} } as Env)
		await vi.advanceTimersByTimeAsync(d1LockRetryBaseDelayMs)
		await expect(recoverPromise).resolves.toEqual({ upserted: 1 })
	} finally {
		vi.useRealTimers()
	}
	expect(mockModule.listMemoriesPage).toHaveBeenCalledTimes(2)
	expect(upsert).toHaveBeenCalledTimes(1)

	resetMocks()
	mockModule.getCapabilityVectorIndex.mockReturnValue({ upsert: vi.fn() })
	mockModule.isCapabilitySearchOffline.mockReturnValue(false)
	mockModule.listMemoriesPage.mockRejectedValue(
		new Error('D1_ERROR: Currently processing a long-running export.'),
	)

	vi.useFakeTimers()
	try {
		const exhaustedPromise = reindexMemoryVectors({ APP_DB: {} } as Env)
		const expectation = expect(exhaustedPromise).rejects.toThrow(
			'Currently processing a long-running export',
		)
		for (let attempt = 1; attempt < d1LockRetryMaxAttempts; attempt++) {
			await vi.advanceTimersByTimeAsync(
				d1LockRetryBaseDelayMs * 2 ** (attempt - 1),
			)
		}
		await expectation
	} finally {
		vi.useRealTimers()
	}

	expect(mockModule.listMemoriesPage).toHaveBeenCalledTimes(
		d1LockRetryMaxAttempts,
	)
})
