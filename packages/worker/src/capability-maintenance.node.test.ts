import { readFileSync } from 'node:fs'
import { expect, test, vi } from 'vitest'

const mockModule = vi.hoisted(() => ({
	reindexCapabilityVectors: vi.fn(),
	reindexJobVectors: vi.fn(),
	reindexMemoryVectors: vi.fn(),
	reindexSavedPackageVectors: vi.fn(),
}))

vi.mock('./mcp/capabilities/registry.ts', () => ({
	getStaticRegistry: async () => ({
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

const env = { CAPABILITY_REINDEX_SECRET: 'secret' } as Env
const allPhases = ['capabilities', 'memories', 'jobs', 'packages']
const phaseMocks = {
	capabilities: mockModule.reindexCapabilityVectors,
	memories: mockModule.reindexMemoryVectors,
	jobs: mockModule.reindexJobVectors,
	packages: mockModule.reindexSavedPackageVectors,
}

function completeStep(upserted: number) {
	return { upserted, complete: true, afterId: null }
}

function mockSteps(steps: Partial<Record<keyof typeof phaseMocks, unknown>>) {
	for (const mock of Object.values(phaseMocks)) mock.mockReset()
	for (const [phase, step] of Object.entries(steps)) {
		const mock = phaseMocks[phase as keyof typeof phaseMocks]
		if (step === undefined) continue
		if (step instanceof Error) mock.mockRejectedValue(step)
		else mock.mockResolvedValue(step)
	}
}

const allComplete = {
	capabilities: completeStep(3),
	memories: completeStep(2),
	jobs: completeStep(1),
	packages: completeStep(4),
}

function reindex(body?: Record<string, unknown>) {
	return handleCapabilityReindexRequest(
		new Request('https://kody.example.com/__maintenance/reindex-capabilities', {
			method: 'POST',
			headers: {
				Authorization: 'Bearer secret',
				'Content-Type': 'application/json',
			},
			body: body === undefined ? undefined : JSON.stringify(body),
		}),
		env,
	)
}

function expectEveryPhaseCalledWith(force: boolean) {
	const options = { afterId: null, deadlineMs: expect.any(Number), force }
	expect(mockModule.reindexCapabilityVectors).toHaveBeenCalledWith(
		env,
		expect.objectContaining({
			example_capability: expect.objectContaining({
				name: 'example_capability',
			}),
		}),
		options,
	)
	expect(mockModule.reindexMemoryVectors).toHaveBeenCalledWith(env, options)
	expect(mockModule.reindexJobVectors).toHaveBeenCalledWith(env, options)
	expect(mockModule.reindexSavedPackageVectors).toHaveBeenCalledWith(env, {
		baseUrl: 'https://kody.example.com',
		...options,
	})
}

test('capability reindex maintenance route rebuilds every vector kind, honors force, and resumes incomplete sweeps', async () => {
	for (const force of [undefined, true]) {
		mockSteps(allComplete)
		const response = await reindex(force === undefined ? undefined : { force })
		expect(response.status).toBe(200)
		await expect(response.json()).resolves.toEqual({
			ok: true,
			complete: true,
			phases: allPhases,
			...allComplete,
		})
		expectEveryPhaseCalledWith(force ?? false)
	}

	const partialMemories = { upserted: 8, complete: false, afterId: 'memory-8' }
	mockSteps({ capabilities: completeStep(3), memories: partialMemories })
	const incompleteResponse = await reindex({ timeBudgetMs: 5_000 })
	expect(incompleteResponse.status).toBe(200)
	await expect(incompleteResponse.json()).resolves.toEqual({
		ok: true,
		complete: false,
		phases: allPhases,
		cursor: { phase: 'memories', afterId: 'memory-8' },
		capabilities: completeStep(3),
		memories: partialMemories,
		jobs: completeStep(0),
		packages: completeStep(0),
	})
	expect(mockModule.reindexJobVectors).not.toHaveBeenCalled()
	expect(mockModule.reindexSavedPackageVectors).not.toHaveBeenCalled()

	mockSteps({ ...allComplete, capabilities: undefined })
	const resumeResponse = await reindex({
		cursor: { phase: 'memories', afterId: 'memory-8' },
	})
	expect(resumeResponse.status).toBe(200)
	await expect(resumeResponse.json()).resolves.toEqual({
		ok: true,
		complete: true,
		phases: allPhases,
		...allComplete,
		capabilities: completeStep(0),
	})
	expect(mockModule.reindexCapabilityVectors).not.toHaveBeenCalled()
	expect(mockModule.reindexMemoryVectors).toHaveBeenCalledWith(env, {
		afterId: 'memory-8',
		deadlineMs: expect.any(Number),
		force: false,
	})
})

test('capability reindex maintenance route attempts every vector kind before reporting failures', async () => {
	const packagesWithFailure = {
		upserted: 4,
		complete: true,
		afterId: null,
		failed: 1,
		error: '1 saved package vector(s) failed to reindex',
	}
	mockSteps({
		...allComplete,
		memories: new Error('memory failed'),
		packages: packagesWithFailure,
	})

	const response = await reindex()

	expect(response.status).toBe(500)
	await expect(response.json()).resolves.toEqual({
		ok: false,
		complete: true,
		phases: allPhases,
		capabilities: completeStep(3),
		memories: {
			upserted: 0,
			complete: false,
			afterId: null,
			error: 'memory failed',
		},
		jobs: completeStep(1),
		packages: packagesWithFailure,
		failure: {
			phase: 'reindex-capability-vectors',
			failedPhases: [
				{ phase: 'memories', cause: 'memory failed' },
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
	for (const mock of Object.values(phaseMocks)) {
		expect(mock).toHaveBeenCalledTimes(1)
	}
})

test('capability reindex can limit work to builtin capabilities for production deploy and rejects invalid options', async () => {
	mockSteps({ capabilities: completeStep(3) })
	const response = await reindex({ phases: ['capabilities'] })
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

	const workflow = readFileSync(
		new URL('../../../.github/workflows/deploy.yml', import.meta.url),
		'utf8',
	)
	expect(workflow).toContain('payload=\'{"phases":["capabilities"]}\'')
	expect(workflow).toContain('{phases:["capabilities"],cursor:$cursor}')

	const invalidRequests: Array<[body: Record<string, unknown>, error: string]> =
		[
			[
				{ cursor: { phase: 'nope', afterId: null } },
				'cursor.phase must be capabilities, memories, jobs, or packages.',
			],
			[{ phases: [] }, 'phases must be a non-empty array.'],
			[
				{ phases: ['capabilities', 'capabilities'] },
				'phases must not contain duplicates.',
			],
			[
				{ phases: ['capabilities', 'nope'] },
				'phases must contain only capabilities, memories, jobs, or packages.',
			],
			[
				{
					phases: ['capabilities'],
					cursor: { phase: 'packages', afterId: null },
				},
				'cursor.phase must be one of the requested phases.',
			],
			[{ force: 'yes' }, 'force must be a boolean.'],
		]
	for (const [body, error] of invalidRequests) {
		const invalid = await reindex(body)
		expect(invalid.status).toBe(400)
		await expect(invalid.json()).resolves.toEqual({ ok: false, error })
	}
})
