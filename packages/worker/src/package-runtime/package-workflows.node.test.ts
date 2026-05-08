import { expect, test, vi } from 'vitest'
import {
	DynamicCallableWorkflowBase,
	PackageWorkflowEntrypointBase,
	createDynamicCallableWorkflow,
	createPackageWorkflow,
	createPackageWorkflowInstance,
	createPackageWorkflowInstanceId,
	createPackageWorkflowPayload,
	createPackageWorkflowPlanDate,
	listWorkflowRunsForUser,
} from './package-workflows.ts'

const invocationMocks = vi.hoisted(() => ({
	invokePackageExport: vi.fn(),
	runModuleWithRegistry: vi.fn(),
}))

vi.mock('#worker/package-invocations/service.ts', () => ({
	invokePackageExport: (...args: Array<unknown>) =>
		invocationMocks.invokePackageExport(...args),
}))

vi.mock('#mcp/run-codemode-registry.ts', () => ({
	runModuleWithRegistry: (...args: Array<unknown>) =>
		invocationMocks.runModuleWithRegistry(...args),
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

function createStatefulWorkflowBinding() {
	const instances = new Map<string, WorkflowInstanceCreateOptions>()
	const create = vi.fn(async (input: WorkflowInstanceCreateOptions) => {
		if (instances.has(input.id)) {
			throw new Error('Workflow instance already exists')
		}
		instances.set(input.id, input)
		return {
			id: input.id,
			status: async () => ({ status: 'queued' }),
		}
	})
	const get = vi.fn(async (id: string) => {
		if (!instances.has(id)) {
			throw new Error('workflow instance does not exist')
		}
		return {
			id,
			status: async () => ({ status: 'waiting' }),
		}
	})
	return {
		workflow: { get, create } as unknown as Workflow,
		get,
		create,
		instances,
	}
}

function createWorkflowRunsDatabase(options?: {
	activeCount?: number
	savedPackage?: Record<string, unknown> | null
}) {
	const workflowRuns = new Map<string, Record<string, unknown>>()
	const savedPackage = options?.savedPackage ?? {
		id: 'pkg-1',
		user_id: 'user-1',
		name: 'Shade automation',
		kody_id: 'shade-automation',
		description: 'Shade automation package',
		tags_json: '[]',
		search_text: null,
		source_id: 'source-1',
		has_app: 0,
		created_at: '2026-05-03T00:00:00.000Z',
		updated_at: '2026-05-03T00:00:00.000Z',
	}
	const db = {
		prepare(query: string) {
			return {
				bind(...params: Array<unknown>) {
					return {
						async first() {
							if (query.includes('COUNT(*) AS count')) {
								return { count: options?.activeCount ?? 0 }
							}
							if (query.includes('FROM saved_packages')) {
								if (!savedPackage) return null
								const userMatches = savedPackage['user_id'] === params[1]
								const idMatches =
									savedPackage['id'] === params[0] ||
									savedPackage['kody_id'] === params[0]
								return userMatches && idMatches ? savedPackage : null
							}
							return null
						},
						async all() {
							const userId = params[0]
							const limit = Number(params[1] ?? 25)
							return {
								results: [...workflowRuns.values()]
									.filter((row) => row['user_id'] === userId)
									.sort((left, right) =>
										String(right['created_at']).localeCompare(
											String(left['created_at']),
										),
									)
									.slice(0, limit),
							}
						},
						async run() {
							if (query.includes('INSERT INTO workflow_runs')) {
								workflowRuns.set(String(params[0]), {
									id: params[0],
									user_id: params[1],
									source_type: params[2],
									package_id: params[3],
									kody_id: params[4],
									source_id: params[5],
									workflow_name: params[6],
									export_name: params[7],
									idempotency_key: params[8],
									run_at: params[9],
									plan_date: params[10],
									status: params[11],
									created_at: params[12],
									updated_at: params[13],
									completed_at: params[14],
									last_error: params[15],
								})
							}
							if (query.includes('UPDATE workflow_runs')) {
								const row = workflowRuns.get(String(params[2]))
								if (row) {
									row['status'] = params[0]
									row['updated_at'] = params[1]
								}
							}
							return { success: true }
						},
					}
				},
			}
		},
		workflowRuns,
	}
	return db as unknown as D1Database & {
		workflowRuns: Map<string, Record<string, unknown>>
	}
}

test('createPackageWorkflowInstanceId is stable and scoped to scheduled package workflow inputs', async () => {
	const first = await createPackageWorkflowInstanceId({
		userId: 'user-1',
		packageId: 'pkg-1',
		workflowName: 'shade-event',
		idempotencyKey: 'event-2026-05-03T10:00:00Z',
		runAt: '2026-05-03T10:00:00.000Z',
	})
	const second = await createPackageWorkflowInstanceId({
		idempotencyKey: 'event-2026-05-03T10:00:00Z',
		workflowName: 'shade-event',
		packageId: 'pkg-1',
		userId: 'user-1',
		runAt: '2026-05-03T10:00:00.000Z',
	})
	const withWhitespace = await createPackageWorkflowInstanceId({
		userId: ' user-1 ',
		packageId: ' pkg-1 ',
		workflowName: ' shade-event ',
		idempotencyKey: ' event-2026-05-03T10:00:00Z ',
		runAt: '2026-05-03T10:00:00.000Z',
	})
	const differentPackage = await createPackageWorkflowInstanceId({
		userId: 'user-1',
		packageId: 'pkg-2',
		workflowName: 'shade-event',
		idempotencyKey: 'event-2026-05-03T10:00:00Z',
		runAt: '2026-05-03T10:00:00.000Z',
	})
	const differentRunAt = await createPackageWorkflowInstanceId({
		userId: 'user-1',
		packageId: 'pkg-1',
		workflowName: 'shade-event',
		idempotencyKey: 'event-2026-05-03T10:00:00Z',
		runAt: '2026-05-04T10:00:00.000Z',
	})

	expect(first).toBe(second)
	expect(first).toBe(withWhitespace)
	expect(first).toMatch(/^pkgwf-[A-Za-z0-9_-]{43}$/)
	expect(differentPackage).not.toBe(first)
	expect(differentRunAt).not.toBe(first)
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

test('createPackageWorkflowInstance creates a new instance for a recurring daily workflow run', async () => {
	const binding = createStatefulWorkflowBinding()
	const yesterday = await createPackageWorkflowInstance({
		workflow: binding.workflow,
		userId: 'user-1',
		packageId: 'pkg-1',
		kodyId: 'shade-automation',
		sourceId: 'source-1',
		workflowName: 'shade-event',
		exportName: './workflow-run-event',
		runAt: '2026-05-06T12:00:00.000Z',
		idempotencyKey: 'morning-shades-up',
		params: { roomId: 'primary-bedroom', action: 'open' },
	})
	const today = await createPackageWorkflowInstance({
		workflow: binding.workflow,
		userId: 'user-1',
		packageId: 'pkg-1',
		kodyId: 'shade-automation',
		sourceId: 'source-1',
		workflowName: 'shade-event',
		exportName: './workflow-run-event',
		runAt: '2026-05-07T12:00:00.000Z',
		idempotencyKey: 'morning-shades-up',
		params: { roomId: 'primary-bedroom', action: 'open' },
	})

	expect(yesterday.id).not.toBe(today.id)
	expect(binding.create).toHaveBeenCalledTimes(2)
	expect(
		[...binding.instances.values()].map((instance) => instance.params),
	).toEqual([
		expect.objectContaining({
			runAt: '2026-05-06T12:00:00.000Z',
			planDate: '2026-05-06',
		}),
		expect.objectContaining({
			runAt: '2026-05-07T12:00:00.000Z',
			planDate: '2026-05-07',
		}),
	])
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

test('createDynamicCallableWorkflow queues inline code without package context', async () => {
	const binding = createStatefulWorkflowBinding()
	const db = createWorkflowRunsDatabase()

	const created = await createDynamicCallableWorkflow({
		env: {
			APP_DB: db,
			DYNAMIC_CALLABLE_WORKFLOWS: binding.workflow,
		} as Env,
		userId: 'user-1',
		packageContext: null,
		body: {
			code: 'export default async function main(p) { return { ok: true, p } }',
			runAt: '2026-05-03T12:34:56.000Z',
			idempotencyKey: 'inline-key',
			params: { greeting: 'hello' },
		},
	})

	expect(created).toMatchObject({
		ok: true,
		id: expect.stringMatching(/^dynwf-/),
		source_type: 'inline',
		workflow_name: 'inline-code',
		export_name: null,
		status: 'queued',
	})
	expect(binding.create).toHaveBeenCalledWith({
		id: created.id,
		params: expect.objectContaining({
			sourceType: 'inline',
			userId: 'user-1',
			code: 'export default async function main(p) { return { ok: true, p } }',
			params: { greeting: 'hello' },
		}),
		retention: {
			successRetention: '30 days',
			errorRetention: '30 days',
		},
	})
})

test('DynamicCallableWorkflowBase executes queued inline code and records completion', async () => {
	const binding = createStatefulWorkflowBinding()
	const db = createWorkflowRunsDatabase()
	const env = {
		APP_DB: db,
		DYNAMIC_CALLABLE_WORKFLOWS: binding.workflow,
		APP_BASE_URL: 'https://app.example.com',
	} as Env
	const created = await createDynamicCallableWorkflow({
		env,
		userId: 'user-1',
		packageContext: null,
		body: {
			code: 'export default async function main(p){ return { ok: true, p }; }',
			runAt: '2026-05-03T12:34:56.000Z',
			idempotencyKey: 'execute-smoke',
			params: { greeting: 'hello' },
		},
	})
	const queued = binding.instances.get(created.id)
	if (!queued?.params) throw new Error('Expected queued workflow payload.')
	invocationMocks.runModuleWithRegistry.mockReset()
	invocationMocks.runModuleWithRegistry.mockResolvedValueOnce({
		result: { ok: true, p: { greeting: 'hello' } },
		logs: [],
	})
	vi.useFakeTimers()
	try {
		vi.setSystemTime(new Date('2026-05-03T12:35:00.000Z'))
		const workflow = new DynamicCallableWorkflowBase(
			{} as ExecutionContext,
			env,
		)
		const stepDo = vi.fn(
			async (_name: string, _config: unknown, callback: () => unknown) =>
				await callback(),
		)
		await expect(
			workflow.run(
				{
					payload: queued.params as never,
					timestamp: new Date(),
					instanceId: created.id,
				},
				{ sleepUntil: vi.fn(), do: stepDo } as unknown as WorkflowStep,
			),
		).resolves.toEqual({ ok: true, p: { greeting: 'hello' } })
		expect(invocationMocks.runModuleWithRegistry).toHaveBeenCalledWith(
			expect.objectContaining({ APP_BASE_URL: 'https://app.example.com' }),
			expect.objectContaining({
				user: expect.objectContaining({ userId: 'user-1' }),
			}),
			'export default async function main(p){ return { ok: true, p }; }',
			{ greeting: 'hello' },
		)
		expect(db.workflowRuns.get(created.id)).toMatchObject({
			status: 'complete',
			completed_at: expect.any(String),
		})
	} finally {
		vi.useRealTimers()
	}
})

test('createDynamicCallableWorkflow verifies package ownership before queueing package exports', async () => {
	const binding = createWorkflowBinding({ existing: null })
	const db = createWorkflowRunsDatabase()

	const created = await createDynamicCallableWorkflow({
		env: {
			APP_DB: db,
			DYNAMIC_CALLABLE_WORKFLOWS: binding.workflow,
		} as Env,
		userId: 'user-1',
		packageContext: null,
		body: {
			packageId: 'pkg-1',
			exportName: './run-event',
			runAt: '2026-05-03T12:34:56.000Z',
			idempotencyKey: 'event-key',
			params: { eventId: 'event-1' },
		},
	})

	expect(created).toMatchObject({
		source_type: 'package',
		package_id: 'pkg-1',
		workflow_name: './run-event',
		export_name: './run-event',
	})
	expect(binding.create).toHaveBeenCalledWith({
		id: created.id,
		params: expect.objectContaining({
			sourceType: 'package',
			packageId: 'pkg-1',
			kodyId: 'shade-automation',
			sourceId: 'source-1',
		}),
		retention: expect.any(Object),
	})

	await expect(
		createDynamicCallableWorkflow({
			env: {
				APP_DB: createWorkflowRunsDatabase({ savedPackage: null }),
				DYNAMIC_CALLABLE_WORKFLOWS: binding.workflow,
			} as Env,
			userId: 'user-1',
			body: {
				packageId: 'not-owned',
				exportName: './run-event',
				runAt: '2026-05-03T12:34:56.000Z',
				idempotencyKey: 'event-key',
			},
		}),
	).rejects.toThrow(
		'Package "not-owned" was not found or is not owned by the current user.',
	)
	await expect(
		createDynamicCallableWorkflow({
			env: {
				APP_DB: db,
				DYNAMIC_CALLABLE_WORKFLOWS: binding.workflow,
			} as Env,
			userId: 'user-1',
			body: {
				code: 'export default async function main() { return { ok: true } }',
				exportName: './run-event',
				runAt: '2026-05-03T12:34:56.000Z',
				idempotencyKey: 'event-key',
			} as never,
		}),
	).rejects.toThrow(
		'workflows.create requires exactly one of exportName or code.',
	)
})

test('createDynamicCallableWorkflow enforces the per-user concurrent workflow limit', async () => {
	await expect(
		createDynamicCallableWorkflow({
			env: {
				APP_DB: createWorkflowRunsDatabase({ activeCount: 100 }),
				DYNAMIC_CALLABLE_WORKFLOWS: createStatefulWorkflowBinding().workflow,
			} as Env,
			userId: 'user-1',
			body: {
				code: 'export default async function main() { return { ok: true } }',
				runAt: '2026-05-03T12:34:56.000Z',
				idempotencyKey: 'inline-key',
			},
		}),
	).rejects.toThrow('per-user concurrent workflow limit (100)')
})

test('listWorkflowRunsForUser returns recent workflow statuses', async () => {
	const binding = createStatefulWorkflowBinding()
	const db = createWorkflowRunsDatabase()
	const env = {
		APP_DB: db,
		DYNAMIC_CALLABLE_WORKFLOWS: binding.workflow,
	} as Env
	const created = await createDynamicCallableWorkflow({
		env,
		userId: 'user-1',
		body: {
			code: 'export default async function main() { return { ok: true } }',
			runAt: '2026-05-03T12:34:56.000Z',
			idempotencyKey: 'inline-key',
		},
	})

	const workflows = await listWorkflowRunsForUser({
		env,
		userId: 'user-1',
		limit: 10,
	})

	expect(workflows).toEqual([
		expect.objectContaining({
			id: created.id,
			sourceType: 'inline',
			status: 'queued',
			idempotencyKey: 'inline-key',
		}),
	])
})

test('PackageWorkflowEntrypoint sleeps for future runAt and invokes saved package export with scoped token', async () => {
	invocationMocks.invokePackageExport.mockReset()
	invocationMocks.invokePackageExport.mockResolvedValueOnce({
		status: 200,
		body: { ok: true, result: { applied: true } },
	})
	vi.useFakeTimers()
	vi.setSystemTime(new Date('2026-05-03T12:00:00.000Z'))
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
		runAt: '2026-05-03T12:34:56.789Z',
		params: { eventId: 'event-1' },
	})

	try {
		const result = await workflow.run(
			{ payload, timestamp: new Date(), instanceId: 'instance-1' },
			{
				sleepUntil,
				do: stepDo,
			} as unknown as WorkflowStep,
		)

		expect(sleepUntil).toHaveBeenCalledWith(
			'wait until package workflow runAt',
			new Date('2026-05-03T12:34:56.789Z'),
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
	} finally {
		vi.useRealTimers()
	}
})

test('PackageWorkflowEntrypoint invokes already-due package workflows without sleeping', async () => {
	invocationMocks.invokePackageExport.mockReset()
	invocationMocks.invokePackageExport.mockResolvedValueOnce({
		status: 200,
		body: { ok: true, result: { applied: true } },
	})
	vi.useFakeTimers()
	vi.setSystemTime(new Date('2026-05-03T12:34:57.000Z'))
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
		runAt: '2026-05-03T12:34:56.789Z',
		params: { eventId: 'event-1' },
	})

	try {
		const result = await workflow.run(
			{ payload, timestamp: new Date(), instanceId: 'instance-1' },
			{
				sleepUntil,
				do: stepDo,
			} as unknown as WorkflowStep,
		)

		expect(sleepUntil).not.toHaveBeenCalled()
		expect(invocationMocks.invokePackageExport).toHaveBeenCalledWith(
			expect.objectContaining({
				request: expect.objectContaining({
					packageIdOrKodyId: 'pkg-1',
					exportName: './run-event',
					idempotencyKey: 'event-key',
					source: 'package-workflow',
					topic: 'shade-event',
				}),
			}),
		)
		expect(result).toEqual({
			status: 200,
			body: { ok: true, result: { applied: true } },
		})
	} finally {
		vi.useRealTimers()
	}
})
