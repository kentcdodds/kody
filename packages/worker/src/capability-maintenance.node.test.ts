import { expect, test, vi } from 'vitest'

const mockModule = vi.hoisted(() => ({
	reindexCapabilityVectors: vi.fn(),
	reindexJobVectors: vi.fn(),
	reindexMemoryVectors: vi.fn(),
	reindexSavedPackageVectors: vi.fn(),
}))

vi.mock('./mcp/capabilities/registry.ts', () => ({
	capabilitySpecs: {
		example_capability: {
			name: 'example_capability',
		},
	},
}))

vi.mock('./mcp/capabilities/capability-reindex.ts', () => ({
	reindexCapabilityVectors: (...args: Array<unknown>) =>
		mockModule.reindexCapabilityVectors(...args),
}))

vi.mock('./jobs/job-reindex.ts', () => ({
	reindexJobVectors: (...args: Array<unknown>) =>
		mockModule.reindexJobVectors(...args),
}))

vi.mock('./mcp/memory/memory-reindex.ts', () => ({
	reindexMemoryVectors: (...args: Array<unknown>) =>
		mockModule.reindexMemoryVectors(...args),
}))

vi.mock('./package-registry/package-reindex.ts', () => ({
	reindexSavedPackageVectors: (...args: Array<unknown>) =>
		mockModule.reindexSavedPackageVectors(...args),
}))

const { handleCapabilityReindexRequest } =
	await import('./capability-maintenance.ts')

function resetMocks() {
	mockModule.reindexCapabilityVectors.mockReset()
	mockModule.reindexMemoryVectors.mockReset()
	mockModule.reindexJobVectors.mockReset()
	mockModule.reindexSavedPackageVectors.mockReset()
}

function createReindexRequest() {
	return new Request(
		'https://kody.example.com/__maintenance/reindex-capabilities',
		{
			method: 'POST',
			headers: { Authorization: 'Bearer secret' },
		},
	)
}

test('capability reindex maintenance route rebuilds every vector kind', async () => {
	resetMocks()
	mockModule.reindexCapabilityVectors.mockResolvedValue({ upserted: 3 })
	mockModule.reindexMemoryVectors.mockResolvedValue({ upserted: 2 })
	mockModule.reindexJobVectors.mockResolvedValue({ upserted: 1 })
	mockModule.reindexSavedPackageVectors.mockResolvedValue({ upserted: 4 })
	const env = {
		CAPABILITY_REINDEX_SECRET: 'secret',
	} as Env

	const response = await handleCapabilityReindexRequest(
		createReindexRequest(),
		env,
	)

	expect(response.status).toBe(200)
	await expect(response.json()).resolves.toEqual({
		ok: true,
		capabilities: { upserted: 3 },
		memories: { upserted: 2 },
		jobs: { upserted: 1 },
		packages: { upserted: 4 },
	})
	expect(mockModule.reindexCapabilityVectors).toHaveBeenCalledWith(
		env,
		expect.objectContaining({
			example_capability: expect.objectContaining({
				name: 'example_capability',
			}),
		}),
	)
	expect(mockModule.reindexMemoryVectors).toHaveBeenCalledWith(env)
	expect(mockModule.reindexJobVectors).toHaveBeenCalledWith(env)
	expect(mockModule.reindexSavedPackageVectors).toHaveBeenCalledWith(env, {
		baseUrl: 'https://kody.example.com',
	})
})

test('capability reindex maintenance route attempts every vector kind before reporting failures', async () => {
	resetMocks()
	mockModule.reindexCapabilityVectors.mockResolvedValue({ upserted: 3 })
	mockModule.reindexMemoryVectors.mockRejectedValue(new Error('memory failed'))
	mockModule.reindexJobVectors.mockResolvedValue({ upserted: 1 })
	mockModule.reindexSavedPackageVectors.mockResolvedValue({
		upserted: 4,
		failed: 1,
		error: '1 saved package vector(s) failed to reindex',
	})
	const env = {
		CAPABILITY_REINDEX_SECRET: 'secret',
	} as Env

	const response = await handleCapabilityReindexRequest(
		createReindexRequest(),
		env,
	)

	expect(response.status).toBe(500)
	await expect(response.json()).resolves.toEqual({
		ok: false,
		capabilities: { upserted: 3 },
		memories: { upserted: 0, error: 'memory failed' },
		jobs: { upserted: 1 },
		packages: {
			upserted: 4,
			failed: 1,
			error: '1 saved package vector(s) failed to reindex',
		},
		failure: {
			phase: 'reindex-capability-vectors',
			failedPhases: [
				{
					phase: 'memories',
					cause: 'memory failed',
				},
				{
					phase: 'packages',
					cause: '1 saved package vector(s) failed to reindex',
					failed: 1,
				},
			],
		},
		error:
			'Capability search vector reindex failed for memories, packages: memories: memory failed; packages: 1 saved package vector(s) failed to reindex',
	})
	expect(mockModule.reindexCapabilityVectors).toHaveBeenCalledTimes(1)
	expect(mockModule.reindexMemoryVectors).toHaveBeenCalledTimes(1)
	expect(mockModule.reindexJobVectors).toHaveBeenCalledTimes(1)
	expect(mockModule.reindexSavedPackageVectors).toHaveBeenCalledTimes(1)
})
