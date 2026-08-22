import { readFileSync } from 'node:fs'
import { expect, test, vi } from 'vitest'

const mockModule = vi.hoisted(() => ({
	reindexCapabilityVectors: vi.fn(),
	reindexJobVectors: vi.fn(),
	reindexMemoryVectors: vi.fn(),
	reindexSavedPackageVectors: vi.fn(),
}))

vi.mock('./mcp/capabilities/registry.ts', () => ({
	getStaticRegistry: () => ({
		capabilitySpecs: {
			example_capability: {
				name: 'example_capability',
			},
		},
	}),
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

function completeStep(upserted: number) {
	return { upserted, complete: true, afterId: null }
}

function createReindexRequest(
	body?: Record<string, unknown>,
	input: { method?: string } = {},
) {
	return new Request(
		'https://kody.example.com/__maintenance/reindex-capabilities',
		{
			method: input.method ?? 'POST',
			headers: {
				Authorization: 'Bearer secret',
				'Content-Type': 'application/json',
			},
			body: body === undefined ? undefined : JSON.stringify(body),
		},
	)
}

test('capability reindex maintenance route rebuilds every vector kind and resumes incomplete sweeps', async () => {
	resetMocks()
	mockModule.reindexCapabilityVectors.mockResolvedValue(completeStep(3))
	mockModule.reindexMemoryVectors.mockResolvedValue(completeStep(2))
	mockModule.reindexJobVectors.mockResolvedValue(completeStep(1))
	mockModule.reindexSavedPackageVectors.mockResolvedValue(completeStep(4))
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
		complete: true,
		phases: ['capabilities', 'memories', 'jobs', 'packages'],
		capabilities: completeStep(3),
		memories: completeStep(2),
		jobs: completeStep(1),
		packages: completeStep(4),
	})
	expect(mockModule.reindexCapabilityVectors).toHaveBeenCalledWith(
		env,
		expect.objectContaining({
			example_capability: expect.objectContaining({
				name: 'example_capability',
			}),
		}),
		{
			afterId: null,
			deadlineMs: expect.any(Number),
			force: false,
		},
	)
	expect(mockModule.reindexMemoryVectors).toHaveBeenCalledWith(env, {
		afterId: null,
		deadlineMs: expect.any(Number),
		force: false,
	})
	expect(mockModule.reindexJobVectors).toHaveBeenCalledWith(env, {
		afterId: null,
		deadlineMs: expect.any(Number),
		force: false,
	})
	expect(mockModule.reindexSavedPackageVectors).toHaveBeenCalledWith(env, {
		baseUrl: 'https://kody.example.com',
		afterId: null,
		deadlineMs: expect.any(Number),
		force: false,
	})

	resetMocks()
	mockModule.reindexCapabilityVectors.mockResolvedValue(completeStep(3))
	mockModule.reindexMemoryVectors.mockResolvedValue({
		upserted: 8,
		complete: false,
		afterId: 'memory-8',
	})
	const incompleteResponse = await handleCapabilityReindexRequest(
		createReindexRequest({ timeBudgetMs: 5_000 }),
		env,
	)
	expect(incompleteResponse.status).toBe(200)
	await expect(incompleteResponse.json()).resolves.toEqual({
		ok: true,
		complete: false,
		phases: ['capabilities', 'memories', 'jobs', 'packages'],
		cursor: { phase: 'memories', afterId: 'memory-8' },
		capabilities: completeStep(3),
		memories: { upserted: 8, complete: false, afterId: 'memory-8' },
		jobs: completeStep(0),
		packages: completeStep(0),
	})
	expect(mockModule.reindexJobVectors).not.toHaveBeenCalled()
	expect(mockModule.reindexSavedPackageVectors).not.toHaveBeenCalled()

	resetMocks()
	mockModule.reindexMemoryVectors.mockResolvedValue(completeStep(2))
	mockModule.reindexJobVectors.mockResolvedValue(completeStep(1))
	mockModule.reindexSavedPackageVectors.mockResolvedValue(completeStep(4))
	const resumeResponse = await handleCapabilityReindexRequest(
		createReindexRequest({
			cursor: { phase: 'memories', afterId: 'memory-8' },
		}),
		env,
	)
	expect(resumeResponse.status).toBe(200)
	await expect(resumeResponse.json()).resolves.toEqual({
		ok: true,
		complete: true,
		phases: ['capabilities', 'memories', 'jobs', 'packages'],
		capabilities: completeStep(0),
		memories: completeStep(2),
		jobs: completeStep(1),
		packages: completeStep(4),
	})
	expect(mockModule.reindexCapabilityVectors).not.toHaveBeenCalled()
	expect(mockModule.reindexMemoryVectors).toHaveBeenCalledWith(env, {
		afterId: 'memory-8',
		deadlineMs: expect.any(Number),
		force: false,
	})

	const invalidCursorResponse = await handleCapabilityReindexRequest(
		createReindexRequest({ cursor: { phase: 'nope', afterId: null } }),
		env,
	)
	expect(invalidCursorResponse.status).toBe(400)
	await expect(invalidCursorResponse.json()).resolves.toEqual({
		ok: false,
		error: 'cursor.phase must be capabilities, memories, jobs, or packages.',
	})
})

test('capability reindex maintenance route attempts every vector kind before reporting failures', async () => {
	resetMocks()
	mockModule.reindexCapabilityVectors.mockResolvedValue(completeStep(3))
	mockModule.reindexMemoryVectors.mockRejectedValue(new Error('memory failed'))
	mockModule.reindexJobVectors.mockResolvedValue(completeStep(1))
	mockModule.reindexSavedPackageVectors.mockResolvedValue({
		upserted: 4,
		complete: true,
		afterId: null,
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
		complete: true,
		phases: ['capabilities', 'memories', 'jobs', 'packages'],
		capabilities: completeStep(3),
		memories: {
			upserted: 0,
			complete: false,
			afterId: null,
			error: 'memory failed',
		},
		jobs: completeStep(1),
		packages: {
			upserted: 4,
			complete: true,
			afterId: null,
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

test('capability reindex can limit work to builtin capabilities for production deploy', async () => {
	resetMocks()
	mockModule.reindexCapabilityVectors.mockResolvedValue(completeStep(3))
	const env = {
		CAPABILITY_REINDEX_SECRET: 'secret',
	} as Env

	const response = await handleCapabilityReindexRequest(
		createReindexRequest({ phases: ['capabilities'] }),
		env,
	)

	expect(response.status).toBe(200)
	await expect(response.json()).resolves.toEqual({
		ok: true,
		complete: true,
		phases: ['capabilities'],
		capabilities: completeStep(3),
		memories: completeStep(0),
		jobs: completeStep(0),
		packages: completeStep(0),
	})
	expect(mockModule.reindexCapabilityVectors).toHaveBeenCalledTimes(1)
	expect(mockModule.reindexMemoryVectors).not.toHaveBeenCalled()
	expect(mockModule.reindexJobVectors).not.toHaveBeenCalled()
	expect(mockModule.reindexSavedPackageVectors).not.toHaveBeenCalled()

	const emptyPhases = await handleCapabilityReindexRequest(
		createReindexRequest({ phases: [] }),
		env,
	)
	expect(emptyPhases.status).toBe(400)
	await expect(emptyPhases.json()).resolves.toEqual({
		ok: false,
		error: 'phases must be a non-empty array.',
	})

	const duplicatePhases = await handleCapabilityReindexRequest(
		createReindexRequest({ phases: ['capabilities', 'capabilities'] }),
		env,
	)
	expect(duplicatePhases.status).toBe(400)
	await expect(duplicatePhases.json()).resolves.toEqual({
		ok: false,
		error: 'phases must not contain duplicates.',
	})

	const invalidPhase = await handleCapabilityReindexRequest(
		createReindexRequest({ phases: ['capabilities', 'nope'] }),
		env,
	)
	expect(invalidPhase.status).toBe(400)
	await expect(invalidPhase.json()).resolves.toEqual({
		ok: false,
		error:
			'phases must contain only capabilities, memories, jobs, or packages.',
	})

	const cursorOutsidePhases = await handleCapabilityReindexRequest(
		createReindexRequest({
			phases: ['capabilities'],
			cursor: { phase: 'packages', afterId: null },
		}),
		env,
	)
	expect(cursorOutsidePhases.status).toBe(400)
	await expect(cursorOutsidePhases.json()).resolves.toEqual({
		ok: false,
		error: 'cursor.phase must be one of the requested phases.',
	})

	const workflow = readFileSync(
		new URL('../../../.github/workflows/deploy.yml', import.meta.url),
		'utf8',
	)
	expect(workflow).toContain('payload=\'{"phases":["capabilities"]}\'')
	expect(workflow).toContain('{phases:["capabilities"],cursor:$cursor}')
})

test('capability reindex force ignores fingerprints and rejects a non-boolean force', async () => {
	resetMocks()
	mockModule.reindexCapabilityVectors.mockResolvedValue(completeStep(3))
	mockModule.reindexMemoryVectors.mockResolvedValue(completeStep(2))
	mockModule.reindexJobVectors.mockResolvedValue(completeStep(1))
	mockModule.reindexSavedPackageVectors.mockResolvedValue(completeStep(4))
	const env = {
		CAPABILITY_REINDEX_SECRET: 'secret',
	} as Env

	const response = await handleCapabilityReindexRequest(
		createReindexRequest({ force: true }),
		env,
	)
	expect(response.status).toBe(200)
	await expect(response.json()).resolves.toEqual({
		ok: true,
		complete: true,
		phases: ['capabilities', 'memories', 'jobs', 'packages'],
		capabilities: completeStep(3),
		memories: completeStep(2),
		jobs: completeStep(1),
		packages: completeStep(4),
	})
	expect(mockModule.reindexCapabilityVectors).toHaveBeenCalledWith(
		env,
		expect.any(Object),
		{
			afterId: null,
			deadlineMs: expect.any(Number),
			force: true,
		},
	)
	expect(mockModule.reindexMemoryVectors).toHaveBeenCalledWith(env, {
		afterId: null,
		deadlineMs: expect.any(Number),
		force: true,
	})
	expect(mockModule.reindexJobVectors).toHaveBeenCalledWith(env, {
		afterId: null,
		deadlineMs: expect.any(Number),
		force: true,
	})
	expect(mockModule.reindexSavedPackageVectors).toHaveBeenCalledWith(env, {
		baseUrl: 'https://kody.example.com',
		afterId: null,
		deadlineMs: expect.any(Number),
		force: true,
	})

	const invalidForce = await handleCapabilityReindexRequest(
		createReindexRequest({ force: 'yes' }),
		env,
	)
	expect(invalidForce.status).toBe(400)
	await expect(invalidForce.json()).resolves.toEqual({
		ok: false,
		error: 'force must be a boolean.',
	})
})
