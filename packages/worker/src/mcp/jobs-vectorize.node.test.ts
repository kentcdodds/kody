import { expect, test, vi } from 'vitest'

const mockModule = vi.hoisted(() => ({
	embedTextForVectorize: vi.fn(),
	getCapabilityVectorIndex: vi.fn(),
	isCapabilitySearchOffline: vi.fn(),
}))

vi.mock('#mcp/capabilities/capability-search.ts', () => ({
	embedTextForVectorize: (...args: Array<unknown>) =>
		mockModule.embedTextForVectorize(...args),
	getCapabilityVectorIndex: (...args: Array<unknown>) =>
		mockModule.getCapabilityVectorIndex(...args),
	isCapabilitySearchOffline: (...args: Array<unknown>) =>
		mockModule.isCapabilitySearchOffline(...args),
}))

const { deleteJobVector, jobVectorId, upsertJobVector } =
	await import('./jobs-vectorize.ts')

const textEncoder = new TextEncoder()

function byteLength(value: string) {
	return textEncoder.encode(value).length
}

test('job vectors use the same length-safe id for upsert and delete', async () => {
	const rawJobId =
		'package-job:b2fda105-005a-4e2b-9f22-1513b6752da2:event-runner'
	const vectorId = jobVectorId(rawJobId)
	const upsert = vi.fn(async () => {})
	const deleteByIds = vi.fn(async () => {})
	const env = {} as Env

	mockModule.embedTextForVectorize.mockReset()
	mockModule.getCapabilityVectorIndex.mockReset()
	mockModule.isCapabilitySearchOffline.mockReset()
	mockModule.embedTextForVectorize.mockResolvedValue([0.1, 0.2, 0.3])
	mockModule.getCapabilityVectorIndex.mockReturnValue({ upsert, deleteByIds })
	mockModule.isCapabilitySearchOffline.mockReturnValue(false)

	expect(byteLength(`job_${rawJobId}`)).toBeGreaterThan(64)
	expect(vectorId).toMatch(/^job_sha256:[0-9a-f]+$/)
	expect(byteLength(vectorId)).toBeLessThanOrEqual(64)

	await upsertJobVector(env, {
		jobId: rawJobId,
		userId: 'user-1',
		embedText: 'event runner job',
	})
	await deleteJobVector(env, rawJobId)

	expect(upsert).toHaveBeenCalledWith([
		{
			id: vectorId,
			values: [0.1, 0.2, 0.3],
			metadata: { kind: 'job', userId: 'user-1' },
		},
	])
	expect(deleteByIds).toHaveBeenCalledWith([vectorId])
})
