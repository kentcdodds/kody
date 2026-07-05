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

test('capability reindex maintenance route rebuilds every vector kind', async () => {
	mockModule.reindexCapabilityVectors.mockResolvedValue({ upserted: 3 })
	mockModule.reindexMemoryVectors.mockResolvedValue({ upserted: 2 })
	mockModule.reindexJobVectors.mockResolvedValue({ upserted: 1 })
	mockModule.reindexSavedPackageVectors.mockResolvedValue({ upserted: 4 })
	const env = {
		CAPABILITY_REINDEX_SECRET: 'secret',
	} as Env
	const request = new Request(
		'http://localhost/__maintenance/reindex-capabilities',
		{
			method: 'POST',
			headers: { Authorization: 'Bearer secret' },
		},
	)

	const response = await handleCapabilityReindexRequest(request, env)

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
	expect(mockModule.reindexSavedPackageVectors).toHaveBeenCalledWith(env)
})
