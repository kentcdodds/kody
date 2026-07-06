import { expect, test, vi } from 'vitest'
import { jobVectorId } from '#mcp/jobs-vectorize.ts'

const mockModule = vi.hoisted(() => ({
	embedTextForVectorize: vi.fn(),
	embedTextsForVectorize: vi.fn(),
	getCapabilityVectorIndex: vi.fn(),
	isCapabilitySearchOffline: vi.fn(),
	listJobs: vi.fn(),
}))

vi.mock('#mcp/capabilities/capability-search.ts', () => ({
	embedTextForVectorize: (...args: Array<unknown>) =>
		mockModule.embedTextForVectorize(...args),
	embedTextsForVectorize: (...args: Array<unknown>) =>
		mockModule.embedTextsForVectorize(...args),
	getCapabilityVectorIndex: (...args: Array<unknown>) =>
		mockModule.getCapabilityVectorIndex(...args),
	isCapabilitySearchOffline: (...args: Array<unknown>) =>
		mockModule.isCapabilitySearchOffline(...args),
}))

vi.mock('./service.ts', () => ({
	listJobs: (...args: Array<unknown>) => mockModule.listJobs(...args),
}))

const { reindexJobVectors } = await import('./job-reindex.ts')

const textEncoder = new TextEncoder()

function byteLength(value: string) {
	return textEncoder.encode(value).length
}

test('job reindex keeps package job vector ids under the Vectorize limit', async () => {
	const rawJobId =
		'package-job:b2fda105-005a-4e2b-9f22-1513b6752da2:event-runner'
	const vectorId = jobVectorId(rawJobId)
	const upsert = vi.fn(async () => {})
	const env = {
		APP_DB: {
			prepare: () => ({
				all: async () => ({ results: [{ user_id: 'user-1' }] }),
			}),
		},
	} as unknown as Env

	mockModule.embedTextsForVectorize.mockReset()
	mockModule.getCapabilityVectorIndex.mockReset()
	mockModule.isCapabilitySearchOffline.mockReset()
	mockModule.listJobs.mockReset()
	mockModule.getCapabilityVectorIndex.mockReturnValue({ upsert })
	mockModule.isCapabilitySearchOffline.mockReturnValue(false)
	mockModule.embedTextsForVectorize.mockResolvedValue([[0.4, 0.5, 0.6]])
	mockModule.listJobs.mockResolvedValue([
		{
			id: rawJobId,
			name: 'Event runner',
			scheduleSummary: 'Every hour',
			sourceId: 'source-1',
			publishedCommit: null,
		},
	])

	await expect(reindexJobVectors(env)).resolves.toEqual({ upserted: 1 })

	expect(byteLength(`job_${rawJobId}`)).toBeGreaterThan(64)
	expect(byteLength(vectorId)).toBeLessThanOrEqual(64)
	expect(upsert).toHaveBeenCalledWith([
		{
			id: vectorId,
			values: [0.4, 0.5, 0.6],
			metadata: { kind: 'job', userId: 'user-1' },
		},
	])
})
