import { expect, test, vi } from 'vitest'
import {
	PackageWorkflowEntrypointBase,
	createPackageWorkflow,
	createPackageWorkflowInstance,
	createPackageWorkflowInstanceId,
	createPackageWorkflowPayload,
	createPackageWorkflowPlanDate,
} from './package-workflows.ts'

const invocationMocks = vi.hoisted(() => ({
	invokePackageExport: vi.fn(),
}))

vi.mock('#worker/package-invocations/service.ts', () => ({
	invokePackageExport: (...args: Array<unknown>) =>
		invocationMocks.invokePackageExport(...args),
}))

function createWorkflowBinding(options?: {
	existing?: { id: string; status?: string } | null
	getThrows?: Error
	createThrows?: Error
}) {
	const create = vi.fn(async (input: WorkflowInstanceCreateOptions) => {
		if (options?.createThrows) throw options.createThrows
		return {
			id: input.id,
			status: async () => ({ status: 'queued' }),
		}
	})
	const get = vi.fn(async (id: string) => {
		if (options?.getThrows) throw options.getThrows
		if (!options || options.existing === null) {
			throw new Error('workflow instance does not exist')
		}
		const existing = options.existing ?? { id, status: 'waiting' }
		return {
			id: existing.id,
			status: async () => ({ status: existing.status ?? 'waiting' }),
		}
	})
	return {
		workflow: { get, create } as unknown as Workflow,
		get,
		create,
	}
}

test('createPackageWorkflowInstanceId is stable and scoped to package workflow inputs', async () => {
	const first = await createPackageWorkflowInstanceId({
		userId: 'user-1',
		packageId: 'pkg-1',
		workflowName: 'shade-event',
		idempotencyKey: 'event-2026-05-03T10:00:00Z',
	})
	const second = await createPackageWorkflowInstanceId({
		idempotencyKey: 'event-2026-05-03T10:00:00Z',
		workflowName: 'shade-event',
		packageId: 'pkg-1',
		userId: 'user-1',
	})
	const differentPackage = await createPackageWorkflowInstanceId({
		userId: 'user-1',
		packageId: 'pkg-2',
		workflowName: 'shade-event',
		idempotencyKey: 'event-2026-05-03T10:00:00Z',
	})

	expect(first).toBe(second)
	expect(first).toMatch(/^pkgwf-[A-Za-z0-9_-]{43}$/)
	expect(differentPackage).not.toBe(first)
})

test('createPackageWorkflowPayload keeps only safe routing metadata and small params', () => {
	const inputParams = {
		eventId: 'event-1',
		roomId: 'office',
		nested: { startedAt: new Date('2026-05-03T00:00:00.000Z') },
		ignored: undefined,
	}
	const payload = createPackageWorkflowPayload({
		userId: 'user-1',
		packageId: 'pkg-1',
		kodyId: 'shade-automation',
		sourceId: 'source-1',
		workflowName: 'shade-event',
		exportName: 'run-event',
		idempotencyKey: 'event-key',
		runAt: '2026-05-03T12:34:56.000Z',
		params: inputParams,
	})

	expect(payload).toEqual({
		version: 1,
		userId: 'user-1',
		packageId: 'pkg-1',
		kodyId: 'shade-automation',
		sourceId: 'source-1',
		workflowName: 'shade-event',
		exportName: './run-event',
		idempotencyKey: 'event-key',
		runAt: '2026-05-03T12:34:56.000Z',
		planDate: '2026-05-03',
		params: {
			eventId: 'event-1',
			roomId: 'office',
			nested: { startedAt: '2026-05-03T00:00:00.000Z' },
		},
	})
	expect(payload.params).not.toBe(inputParams)
	expect(createPackageWorkflowPlanDate(payload.runAt)).toBe('2026-05-03')
})

test('createPackageWorkflowInstance creates deterministic instance and returns existing instance on replay', async () => {
	const createdBinding = createWorkflowBinding({ existing: null })
	const created = await createPackageWorkflowInstance({
		workflow: createdBinding.workflow,
		userId: 'user-1',
		packageId: 'pkg-1',
		kodyId: 'shade-automation',
		sourceId: 'source-1',
		workflowName: 'shade-event',
		exportName: './run-event',
		runAt: '2026-05-03T12:34:56.000Z',
		idempotencyKey: 'event-key',
		params: { eventId: 'event-1' },
	})

	expect(createdBinding.create).toHaveBeenCalledWith({
		id: created.id,
		params: expect.objectContaining({
			workflowName: 'shade-event',
			exportName: './run-event',
			idempotencyKey: 'event-key',
			params: { eventId: 'event-1' },
		}),
		retention: {
			successRetention: '30 days',
			errorRetention: '30 days',
		},
	})
	expect(created).toMatchObject({
		ok: true,
		workflow_name: 'shade-event',
		export_name: './run-event',
		run_at: '2026-05-03T12:34:56.000Z',
		plan_date: '2026-05-03',
		status: 'queued',
	})

	const existingBinding = createWorkflowBinding({
		existing: { id: created.id, status: 'waiting' },
	})
	const replayed = await createPackageWorkflowInstance({
		workflow: existingBinding.workflow,
		userId: 'user-1',
		packageId: 'pkg-1',
		kodyId: 'shade-automation',
		sourceId: 'source-1',
		workflowName: 'shade-event',
		exportName: './run-event',
		runAt: '2026-05-03T12:34:56.000Z',
		idempotencyKey: 'event-key',
	})

	expect(existingBinding.create).not.toHaveBeenCalled()
	expect(replayed).toMatchObject({
		id: created.id,
		status: 'waiting',
	})
})

test('createPackageWorkflowInstance returns existing instance after duplicate create race', async () => {
	const binding = createWorkflowBinding({
		existing: null,
		createThrows: new Error('Workflow instance already exists'),
	})
	let lookupCount = 0
	binding.get.mockImplementation(async (id: string) => {
		lookupCount += 1
		if (lookupCount === 1) {
			throw new Error('workflow instance does not exist')
		}
		return {
			id,
			status: async () => ({ status: 'waiting' }),
		}
	})

	const result = await createPackageWorkflowInstance({
		workflow: binding.workflow,
		userId: 'user-1',
		packageId: 'pkg-1',
		kodyId: 'shade-automation',
		sourceId: 'source-1',
		workflowName: 'shade-event',
		exportName: './run-event',
		runAt: '2026-05-03T12:34:56.000Z',
		idempotencyKey: 'event-key',
	})

	expect(binding.create).toHaveBeenCalledTimes(1)
	expect(binding.get).toHaveBeenCalledTimes(2)
	expect(result).toMatchObject({
		ok: true,
		id: expect.stringMatching(/^pkgwf-/),
		workflow_name: 'shade-event',
		status: 'waiting',
	})
})

test('createPackageWorkflow forwards package context into the workflow helper', async () => {
	const binding = createWorkflowBinding({ existing: null })
	const created = await createPackageWorkflow({
		env: { PACKAGE_WORKFLOWS: binding.workflow } as Env,
		userId: 'user-1',
		packageId: 'pkg-1',
		kodyId: 'shade-automation',
		sourceId: 'source-1',
		body: {
			workflowName: 'shade-event',
			exportName: './run-event',
			runAt: '2026-05-03T12:34:56.000Z',
			idempotencyKey: 'event-key',
			params: { eventId: 'event-1' },
		},
	})

	expect(created.workflow_name).toBe('shade-event')
	expect(binding.create).toHaveBeenCalledWith({
		id: created.id,
		params: expect.objectContaining({
			userId: 'user-1',
			packageId: 'pkg-1',
			kodyId: 'shade-automation',
			sourceId: 'source-1',
			exportName: './run-event',
			params: { eventId: 'event-1' },
		}),
		retention: {
			successRetention: '30 days',
			errorRetention: '30 days',
		},
	})
})

test('PackageWorkflowEntrypoint sleeps until runAt and invokes saved package export with scoped token', async () => {
	invocationMocks.invokePackageExport.mockReset()
	invocationMocks.invokePackageExport.mockResolvedValueOnce({
		status: 200,
		body: { ok: true, result: { applied: true } },
	})
	const workflow = new PackageWorkflowEntrypointBase(
		{} as ExecutionContext,
		{ APP_BASE_URL: 'https://app.example.com' } as Env,
	)
	const sleepUntil = vi.fn(async () => undefined)
	const stepDo = vi.fn(
		async (_name: string, _config: unknown, callback: () => unknown) => {
			return await callback()
		},
	)
	const payload = createPackageWorkflowPayload({
		userId: 'user-1',
		packageId: 'pkg-1',
		kodyId: 'shade-automation',
		sourceId: 'source-1',
		workflowName: 'shade-event',
		exportName: './run-event',
		idempotencyKey: 'event-key',
		runAt: '2026-05-03T12:34:56.000Z',
		params: { eventId: 'event-1' },
	})

	const result = await workflow.run(
		{ payload, timestamp: new Date(), instanceId: 'instance-1' },
		{
			sleepUntil,
			do: stepDo,
		} as unknown as WorkflowStep,
	)

	expect(sleepUntil).toHaveBeenCalledWith(
		'wait until package workflow runAt',
		new Date('2026-05-03T12:34:56.000Z'),
	)
	expect(stepDo).toHaveBeenCalledWith(
		'invoke saved package workflow export',
		expect.objectContaining({
			retries: expect.objectContaining({ limit: 3 }),
			timeout: '5 minutes',
		}),
		expect.any(Function),
	)
	expect(invocationMocks.invokePackageExport).toHaveBeenCalledWith({
		env: expect.objectContaining({ APP_BASE_URL: 'https://app.example.com' }),
		baseUrl: 'https://app.example.com',
		token: expect.objectContaining({
			tokenId: 'internal:package-workflows',
			userId: 'user-1',
			packageIds: ['pkg-1'],
			packageKodyIds: ['shade-automation'],
			exportNames: ['./run-event'],
			sources: ['package-workflow'],
		}),
		request: {
			packageIdOrKodyId: 'pkg-1',
			exportName: './run-event',
			params: { eventId: 'event-1' },
			idempotencyKey: 'event-key',
			source: 'package-workflow',
			topic: 'shade-event',
		},
	})
	expect(result).toEqual({
		status: 200,
		body: { ok: true, result: { applied: true } },
	})
})
