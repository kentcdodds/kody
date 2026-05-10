import { expect, test, vi } from 'vitest'
import {
	DynamicCallableWorkflowBase,
	createDynamicCallableWorkflow,
	createPackageWorkflowInstanceId,
	listWorkflowRunsForUser,
} from './package-workflows.ts'

const invocationMocks = vi.hoisted(() => ({
	invokePackageExport: vi.fn(),
	runModuleWithRegistry: vi.fn(),
}))

const remoteConnectorMocks = vi.hoisted(() => ({
	safelyListAttachedRemoteConnectorRefs: vi.fn(async () => []),
}))

vi.mock('#worker/package-invocations/service.ts', () => ({
	invokePackageExport: (...args: Array<unknown>) =>
		invocationMocks.invokePackageExport(...args),
}))

vi.mock('#worker/remote-connector/settings-service.ts', () => ({
	safelyListAttachedRemoteConnectorRefs: (...args: Array<unknown>) =>
		remoteConnectorMocks.safelyListAttachedRemoteConnectorRefs(...args),
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
							if (
								query.includes('FROM workflow_runs') &&
								query.includes('idempotency_key = ?')
							) {
								const userId = params[0]
								const idempotencyKey = params[1]
								const matches = [...workflowRuns.values()]
									.filter(
										(row) =>
											row['user_id'] === userId &&
											row['idempotency_key'] === idempotencyKey,
									)
									.sort((left, right) =>
										String(left['created_at']).localeCompare(
											String(right['created_at']),
										),
									)
								return matches[0] ?? null
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

test('DynamicCallableWorkflowBase restores attached remote connectors for inline code', async () => {
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
			code: 'export default async function main(){ return { ok: true }; }',
			runAt: '2026-05-03T12:34:56.000Z',
			idempotencyKey: 'execute-remote-connector-smoke',
		},
	})
	const queued = binding.instances.get(created.id)
	if (!queued?.params) throw new Error('Expected queued workflow payload.')
	invocationMocks.runModuleWithRegistry.mockReset()
	invocationMocks.runModuleWithRegistry.mockResolvedValueOnce({
		result: { ok: true },
		logs: [],
	})
	remoteConnectorMocks.safelyListAttachedRemoteConnectorRefs.mockResolvedValueOnce(
		[{ kind: 'home', instanceId: 'default' }],
	)

	const workflow = new DynamicCallableWorkflowBase({} as ExecutionContext, env)
	const stepDo = vi.fn(
		async (_name: string, _config: unknown, callback: () => unknown) =>
			await callback(),
	)
	await workflow.run(
		{
			payload: queued.params as never,
			timestamp: new Date(),
			instanceId: created.id,
		},
		{ sleepUntil: vi.fn(), do: stepDo } as unknown as WorkflowStep,
	)

	expect(
		remoteConnectorMocks.safelyListAttachedRemoteConnectorRefs,
	).toHaveBeenCalledWith({
		env,
		userId: 'user-1',
	})
	expect(invocationMocks.runModuleWithRegistry).toHaveBeenCalledWith(
		expect.any(Object),
		expect.objectContaining({
			remoteConnectors: [{ kind: 'home', instanceId: 'default' }],
		}),
		expect.any(String),
		undefined,
	)
})

test('DynamicCallableWorkflowBase restores attached remote connectors for package exports', async () => {
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
			packageId: 'pkg-1',
			exportName: './workflow-run-event',
			runAt: '2026-05-03T12:34:56.000Z',
			idempotencyKey: 'package-remote-connector-smoke',
			params: { key: 'north-east-open' },
		},
	})
	const queued = binding.instances.get(created.id)
	if (!queued?.params) throw new Error('Expected queued workflow payload.')
	invocationMocks.invokePackageExport.mockReset()
	invocationMocks.invokePackageExport.mockResolvedValueOnce({
		status: 200,
		body: { result: { ok: true } },
	})
	remoteConnectorMocks.safelyListAttachedRemoteConnectorRefs.mockResolvedValueOnce(
		[{ kind: 'home', instanceId: 'default' }],
	)

	const workflow = new DynamicCallableWorkflowBase({} as ExecutionContext, env)
	const stepDo = vi.fn(
		async (_name: string, _config: unknown, callback: () => unknown) =>
			await callback(),
	)
	await workflow.run(
		{
			payload: queued.params as never,
			timestamp: new Date(),
			instanceId: created.id,
		},
		{ sleepUntil: vi.fn(), do: stepDo } as unknown as WorkflowStep,
	)

	expect(
		remoteConnectorMocks.safelyListAttachedRemoteConnectorRefs,
	).toHaveBeenCalledWith({
		env,
		userId: 'user-1',
	})
	expect(invocationMocks.invokePackageExport).toHaveBeenCalledWith(
		expect.objectContaining({
			token: expect.objectContaining({
				remoteConnectors: [{ kind: 'home', instanceId: 'default' }],
			}),
		}),
	)
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

test('createDynamicCallableWorkflow dedupes by (user_id, idempotency_key) across runAt changes and runs the workflow only once', async () => {
	const binding = createStatefulWorkflowBinding()
	const db = createWorkflowRunsDatabase()
	const env = {
		APP_DB: db,
		DYNAMIC_CALLABLE_WORKFLOWS: binding.workflow,
	} as Env

	const first = await createDynamicCallableWorkflow({
		env,
		userId: 'user-1',
		body: {
			packageId: 'pkg-1',
			exportName: './workflow-run-event',
			runAt: '2026-05-08T19:30:00.000Z',
			idempotencyKey: 'idempotency-repro',
			params: { date: '2026-05-08', key: 'noop' },
		},
	})

	const second = await createDynamicCallableWorkflow({
		env,
		userId: 'user-1',
		body: {
			packageId: 'pkg-1',
			exportName: './workflow-run-event',
			runAt: '2026-05-08T19:31:00.000Z',
			idempotencyKey: 'idempotency-repro',
			params: { date: '2026-05-08', key: 'noop' },
		},
	})

	expect(second.id).toBe(first.id)
	expect(second).toMatchObject({
		ok: true,
		id: first.id,
		source_type: 'package',
		package_id: 'pkg-1',
		export_name: './workflow-run-event',
		run_at: first.run_at,
	})
	expect(binding.create).toHaveBeenCalledTimes(1)
	expect(binding.instances.size).toBe(1)
	expect(db.workflowRuns.size).toBe(1)
	const stored = [...db.workflowRuns.values()]
	expect(stored).toHaveLength(1)
	expect(stored[0]).toMatchObject({
		idempotency_key: 'idempotency-repro',
		run_at: '2026-05-08T19:30:00.000Z',
	})
})

test('createDynamicCallableWorkflow scopes idempotency dedupe per user', async () => {
	const binding = createStatefulWorkflowBinding()
	const db = createWorkflowRunsDatabase({
		savedPackage: {
			id: 'pkg-1',
			user_id: 'user-2',
			name: 'Shade automation',
			kody_id: 'shade-automation',
			description: 'Shade automation package',
			tags_json: '[]',
			search_text: null,
			source_id: 'source-1',
			has_app: 0,
			created_at: '2026-05-03T00:00:00.000Z',
			updated_at: '2026-05-03T00:00:00.000Z',
		},
	})
	const env = {
		APP_DB: db,
		DYNAMIC_CALLABLE_WORKFLOWS: binding.workflow,
	} as Env

	const userOne = await createDynamicCallableWorkflow({
		env: {
			APP_DB: createWorkflowRunsDatabase(),
			DYNAMIC_CALLABLE_WORKFLOWS: binding.workflow,
		} as Env,
		userId: 'user-1',
		body: {
			packageId: 'pkg-1',
			exportName: './workflow-run-event',
			runAt: '2026-05-08T19:30:00.000Z',
			idempotencyKey: 'shared-key',
		},
	})
	const userTwo = await createDynamicCallableWorkflow({
		env,
		userId: 'user-2',
		body: {
			packageId: 'pkg-1',
			exportName: './workflow-run-event',
			runAt: '2026-05-08T19:30:00.000Z',
			idempotencyKey: 'shared-key',
		},
	})

	expect(userOne.id).not.toBe(userTwo.id)
	expect(binding.create).toHaveBeenCalledTimes(2)
})

test('createDynamicCallableWorkflow dedupes even when the prior run terminated with an error', async () => {
	const binding = createStatefulWorkflowBinding()
	const db = createWorkflowRunsDatabase()
	const env = {
		APP_DB: db,
		DYNAMIC_CALLABLE_WORKFLOWS: binding.workflow,
	} as Env

	const first = await createDynamicCallableWorkflow({
		env,
		userId: 'user-1',
		body: {
			packageId: 'pkg-1',
			exportName: './workflow-run-event',
			runAt: '2026-05-08T19:30:00.000Z',
			idempotencyKey: 'terminal-key',
		},
	})
	const stored = db.workflowRuns.get(first.id)
	if (!stored) throw new Error('Expected stored workflow row.')
	stored['status'] = 'errored'

	const replay = await createDynamicCallableWorkflow({
		env,
		userId: 'user-1',
		body: {
			packageId: 'pkg-1',
			exportName: './workflow-run-event',
			runAt: '2026-05-08T19:31:00.000Z',
			idempotencyKey: 'terminal-key',
		},
	})

	expect(replay.id).toBe(first.id)
	expect(replay.status).toBe('errored')
	expect(binding.create).toHaveBeenCalledTimes(1)
})

test('createDynamicCallableWorkflow normalizes exportName: FQN, relative, and bare forms store without doubled "./"', async () => {
	for (const form of [
		'kody:@kentcdodds/shade-automation/workflow-run-event',
		'./workflow-run-event',
		'workflow-run-event',
	]) {
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
				packageId: 'pkg-1',
				exportName: form,
				runAt: '2026-05-08T19:30:00.000Z',
				idempotencyKey: `key-${form}`,
			},
		})
		const expectedExportName = form.startsWith('kody:')
			? form
			: form.startsWith('./')
				? form
				: `./${form}`
		expect(created.export_name, `create result for ${form}`).toBe(
			expectedExportName,
		)
		expect(
			db.workflowRuns.get(created.id)?.['export_name'],
			`stored row for ${form}`,
		).toBe(expectedExportName)
	}
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
