import { expect, test, vi } from 'vitest'
import { isEntitlementLimitError } from '#worker/entitlements/errors.ts'
import { planLimits } from '#worker/entitlements/plans.ts'
import { createStableUserIdFromEmail } from '#worker/user-id.ts'
import {
	DynamicCallableWorkflowBase,
	createDynamicCallableWorkflow,
	listWorkflowRunsForUser,
} from './package-workflows.ts'

const invocationMocks = vi.hoisted(() => ({
	invokePackageExport: vi.fn(),
	runModuleWithRegistry: vi.fn(),
}))

const remoteConnectorMocks = vi.hoisted(() => ({
	listAttachedRemoteConnectorRefs: vi.fn(async () => []),
}))

vi.mock('#worker/package-invocations/service.ts', () => ({
	invokePackageExport: (...args: Array<unknown>) =>
		invocationMocks.invokePackageExport(...args),
}))

vi.mock('#worker/remote-connector/settings-service.ts', () => ({
	listAttachedRemoteConnectorRefs: (...args: Array<unknown>) =>
		remoteConnectorMocks.listAttachedRemoteConnectorRefs(...args),
}))

vi.mock('#mcp/run-kody-registry.ts', () => ({
	runModuleWithRegistry: (...args: Array<unknown>) =>
		invocationMocks.runModuleWithRegistry(...args),
}))

function createWorkflowBinding(options?: {
	existing?: { id: string; status?: string } | null
	getThrows?: Error
	createThrows?: Error
	statusThrows?: Error
}) {
	const create = vi.fn(async (input: WorkflowInstanceCreateOptions) => {
		if (options?.createThrows) throw options.createThrows
		return {
			id: input.id,
			status: async () => {
				if (options?.statusThrows) throw options.statusThrows
				return { status: 'queued' }
			},
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
			status: async () => {
				if (options.statusThrows) throw options.statusThrows
				return { status: existing.status ?? 'waiting' }
			},
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
	users?: Array<{ email: string; plan: string | null }>
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
							if (query.includes('SELECT plan FROM users WHERE email = ?')) {
								const email = String(params[0] ?? '')
								const user = (options?.users ?? []).find(
									(row) => row.email === email,
								)
								return user ? { plan: user.plan } : null
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
								const ignoredStatus = query.includes(
									"COALESCE(status, '') != ?",
								)
									? params[2]
									: null
								const matches = [...workflowRuns.values()]
									.filter(
										(row) =>
											row['user_id'] === userId &&
											row['idempotency_key'] === idempotencyKey &&
											row['status'] !== ignoredStatus,
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
								const id = String(params[0])
								const existing = workflowRuns.get(id)
								if (existing) {
									existing['status'] = params[11]
									existing['updated_at'] = params[13]
									existing['completed_at'] =
										params[14] ?? existing['completed_at']
									existing['last_error'] = params[15] ?? existing['last_error']
								} else {
									workflowRuns.set(id, {
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

test('createDynamicCallableWorkflow queues inline code without package context and records runs before status reads', async () => {
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
			version: 3,
			sourceType: 'inline',
			userId: 'user-1',
			packageContext: null,
			code: 'export default async function main(p) { return { ok: true, p } }',
			params: { greeting: 'hello' },
		}),
		retention: {
			successRetention: '30 days',
			errorRetention: '30 days',
		},
	})

	const statusFailureBinding = createWorkflowBinding({
		existing: null,
		statusThrows: new Error('status unavailable'),
	})
	const statusFailureDb = createWorkflowRunsDatabase()
	await expect(
		createDynamicCallableWorkflow({
			env: {
				APP_DB: statusFailureDb,
				DYNAMIC_CALLABLE_WORKFLOWS: statusFailureBinding.workflow,
			} as Env,
			userId: 'user-1',
			packageContext: null,
			body: {
				code: 'export default async function main() { return { ok: true } }',
				runAt: '2026-05-03T12:34:56.000Z',
				idempotencyKey: 'status-failure-key',
			},
		}),
	).rejects.toThrow('status unavailable')
	expect([...statusFailureDb.workflowRuns.values()]).toEqual([
		expect.objectContaining({
			status: 'queued',
			idempotency_key: 'status-failure-key',
		}),
	])
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
				executionOrigin: 'background',
				user: expect.objectContaining({ userId: 'user-1' }),
			}),
			'export default async function main(p){ return { ok: true, p }; }',
			{ greeting: 'hello' },
			{ packageContext: null },
		)
		expect(db.workflowRuns.get(created.id)).toMatchObject({
			status: 'complete',
			completed_at: expect.any(String),
		})
	} finally {
		vi.useRealTimers()
	}
})

test('package-created inline workflows retain package secret authorization context', async () => {
	const binding = createStatefulWorkflowBinding()
	const env = {
		APP_DB: createWorkflowRunsDatabase(),
		DYNAMIC_CALLABLE_WORKFLOWS: binding.workflow,
		APP_BASE_URL: 'https://app.example.com',
	} as Env
	const packageContext = {
		packageId: 'package-1',
		kodyId: 'example-package',
		sourceId: 'source-1',
	}
	const created = await createDynamicCallableWorkflow({
		env,
		userId: 'user-1',
		packageContext,
		body: {
			code: 'export default async function main(){ return { ok: true }; }',
			idempotencyKey: 'package-inline-security-context',
		},
	})
	const queued = binding.instances.get(created.id)
	if (!queued?.params) throw new Error('Expected queued workflow payload.')
	invocationMocks.runModuleWithRegistry.mockReset()
	invocationMocks.runModuleWithRegistry.mockResolvedValueOnce({
		result: { ok: true },
		logs: [],
	})
	const stepDo = vi.fn(
		async (_name: string, _config: unknown, callback: () => unknown) =>
			await callback(),
	)
	const legacyPayload = {
		...(queued.params as Record<string, unknown>),
	}
	delete legacyPayload['packageContext']
	await expect(
		new DynamicCallableWorkflowBase({} as ExecutionContext, env).run(
			{
				payload: legacyPayload as never,
				timestamp: new Date(),
				instanceId: 'legacy-inline-workflow',
			},
			{ sleepUntil: vi.fn(), do: stepDo } as unknown as WorkflowStep,
		),
	).rejects.toThrow('packageContext must be an object or null')

	await new DynamicCallableWorkflowBase({} as ExecutionContext, env).run(
		{
			payload: queued.params as never,
			timestamp: new Date(),
			instanceId: created.id,
		},
		{ sleepUntil: vi.fn(), do: stepDo } as unknown as WorkflowStep,
	)

	expect(invocationMocks.runModuleWithRegistry).toHaveBeenCalledWith(
		expect.any(Object),
		expect.objectContaining({
			storageContext: {
				sessionId: null,
				appId: 'package-1',
				packageId: 'package-1',
				storageId: null,
			},
		}),
		expect.any(String),
		undefined,
		{ packageContext },
	)
})

test('DynamicCallableWorkflowBase restores attached remote connectors for inline code and package exports', async () => {
	const remoteConnectors = [{ instanceId: 'home' }]
	const stepDo = vi.fn(
		async (_name: string, _config: unknown, callback: () => unknown) =>
			await callback(),
	)

	const inlineBinding = createStatefulWorkflowBinding()
	const inlineEnv = {
		APP_DB: createWorkflowRunsDatabase(),
		DYNAMIC_CALLABLE_WORKFLOWS: inlineBinding.workflow,
		APP_BASE_URL: 'https://app.example.com',
	} as Env
	const inlineCreated = await createDynamicCallableWorkflow({
		env: inlineEnv,
		userId: 'user-1',
		packageContext: null,
		body: {
			code: 'export default async function main(){ return { ok: true }; }',
			runAt: '2026-05-03T12:34:56.000Z',
			idempotencyKey: 'execute-remote-connector-smoke',
		},
	})
	const inlineQueued = inlineBinding.instances.get(inlineCreated.id)
	if (!inlineQueued?.params)
		throw new Error('Expected queued workflow payload.')
	invocationMocks.runModuleWithRegistry.mockReset()
	invocationMocks.runModuleWithRegistry.mockResolvedValueOnce({
		result: { ok: true },
		logs: [],
	})
	remoteConnectorMocks.listAttachedRemoteConnectorRefs.mockResolvedValueOnce(
		remoteConnectors,
	)
	await new DynamicCallableWorkflowBase({} as ExecutionContext, inlineEnv).run(
		{
			payload: inlineQueued.params as never,
			timestamp: new Date(),
			instanceId: inlineCreated.id,
		},
		{ sleepUntil: vi.fn(), do: stepDo } as unknown as WorkflowStep,
	)
	expect(
		remoteConnectorMocks.listAttachedRemoteConnectorRefs,
	).toHaveBeenCalledWith({
		env: inlineEnv,
		userId: 'user-1',
	})
	expect(invocationMocks.runModuleWithRegistry).toHaveBeenCalledWith(
		expect.any(Object),
		expect.objectContaining({ remoteConnectors }),
		expect.any(String),
		undefined,
		{ packageContext: null },
	)

	const packageBinding = createStatefulWorkflowBinding()
	const packageEnv = {
		APP_DB: createWorkflowRunsDatabase(),
		DYNAMIC_CALLABLE_WORKFLOWS: packageBinding.workflow,
		APP_BASE_URL: 'https://app.example.com',
	} as Env
	const packageCreated = await createDynamicCallableWorkflow({
		env: packageEnv,
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
	const packageQueued = packageBinding.instances.get(packageCreated.id)
	if (!packageQueued?.params)
		throw new Error('Expected queued workflow payload.')
	invocationMocks.invokePackageExport.mockReset()
	invocationMocks.invokePackageExport.mockResolvedValueOnce({
		status: 200,
		body: { result: { ok: true } },
	})
	remoteConnectorMocks.listAttachedRemoteConnectorRefs.mockResolvedValueOnce(
		remoteConnectors,
	)
	await new DynamicCallableWorkflowBase({} as ExecutionContext, packageEnv).run(
		{
			payload: packageQueued.params as never,
			timestamp: new Date(),
			instanceId: packageCreated.id,
		},
		{ sleepUntil: vi.fn(), do: stepDo } as unknown as WorkflowStep,
	)
	expect(
		remoteConnectorMocks.listAttachedRemoteConnectorRefs,
	).toHaveBeenCalledWith({
		env: packageEnv,
		userId: 'user-1',
	})
	expect(invocationMocks.invokePackageExport).toHaveBeenCalledWith(
		expect.objectContaining({
			token: expect.objectContaining({ remoteConnectors }),
		}),
	)
})

test('DynamicCallableWorkflowBase marks package export error responses as workflow errors', async () => {
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
			idempotencyKey: 'package-error-response-smoke',
			params: { key: 'west-sensitive-reopen' },
		},
	})
	const queued = binding.instances.get(created.id)
	if (!queued?.params) throw new Error('Expected queued workflow payload.')
	invocationMocks.invokePackageExport.mockReset()
	invocationMocks.invokePackageExport.mockResolvedValueOnce({
		status: 500,
		body: {
			ok: false,
			error: {
				message:
					'Shade workflow event failed: Tool "kody.remote[\\"home\\"].bond_shade_set_position" not found',
			},
		},
	})

	const workflow = new DynamicCallableWorkflowBase({} as ExecutionContext, env)
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
	).rejects.toThrow('kody.remote[\\"home\\"].bond_shade_set_position')
	expect(db.workflowRuns.get(created.id)).toMatchObject({
		status: 'errored',
		completed_at: expect.any(String),
		last_error: expect.stringContaining(
			'kody.remote[\\"home\\"].bond_shade_set_position',
		),
	})
})

test('DynamicCallableWorkflowBase rejects package export redirect responses', async () => {
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
			idempotencyKey: 'package-redirect-response-smoke',
			params: { key: 'west-sensitive-reopen' },
		},
	})
	const queued = binding.instances.get(created.id)
	if (!queued?.params) throw new Error('Expected queued workflow payload.')
	invocationMocks.invokePackageExport.mockReset()
	invocationMocks.invokePackageExport.mockResolvedValueOnce({
		status: 302,
		body: { ok: false },
	})

	const workflow = new DynamicCallableWorkflowBase({} as ExecutionContext, env)
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
	).rejects.toThrow('Package workflow export failed with HTTP 302.')
	expect(db.workflowRuns.get(created.id)).toMatchObject({
		status: 'errored',
		completed_at: expect.any(String),
		last_error: 'Package workflow export failed with HTTP 302.',
	})
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

test('createDynamicCallableWorkflow dedupes queued runs by user and idempotency key', async () => {
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
	const replay = await createDynamicCallableWorkflow({
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
	expect(replay.id).toBe(first.id)
	expect(replay).toMatchObject({
		ok: true,
		id: first.id,
		source_type: 'package',
		package_id: 'pkg-1',
		export_name: './workflow-run-event',
		run_at: first.run_at,
	})
	expect(binding.create).toHaveBeenCalledTimes(1)
	expect(binding.instances.size).toBe(1)
	expect([...db.workflowRuns.values()]).toEqual([
		expect.objectContaining({
			idempotency_key: 'idempotency-repro',
			run_at: '2026-05-08T19:30:00.000Z',
		}),
	])

	const preProjectionDb = createWorkflowRunsDatabase()
	const preProjectionInstances = new Map<
		string,
		WorkflowInstanceCreateOptions
	>()
	const preProjectionCreate = vi.fn(
		async (input: WorkflowInstanceCreateOptions) => {
			expect([...preProjectionDb.workflowRuns.values()]).toEqual([
				expect.objectContaining({
					id: input.id,
					idempotency_key: 'inline-pre-projection-key',
					run_at: '2026-05-08T19:30:00.000Z',
					status: 'creating',
				}),
			])
			preProjectionInstances.set(input.id, input)
			return {
				id: input.id,
				status: async () => ({ status: 'queued' }),
			} as WorkflowInstance
		},
	)
	const preProjectionGet = vi.fn(async (id: string) => {
		if (!preProjectionInstances.has(id)) {
			throw new Error('workflow instance does not exist')
		}
		return {
			id,
			status: async () => ({ status: 'waiting' }),
		} as WorkflowInstance
	})
	const preProjectionEnv = {
		APP_DB: preProjectionDb,
		DYNAMIC_CALLABLE_WORKFLOWS: {
			get: preProjectionGet,
			create: preProjectionCreate,
		} as unknown as Workflow,
	} as Env
	vi.useFakeTimers()
	try {
		vi.setSystemTime(new Date('2026-05-08T19:30:00.000Z'))
		const firstPreProjection = await createDynamicCallableWorkflow({
			env: preProjectionEnv,
			userId: 'user-1',
			body: {
				code: 'export default async function main() { return { ok: true } }',
				idempotencyKey: 'inline-pre-projection-key',
			},
		})
		vi.setSystemTime(new Date('2026-05-08T19:31:00.000Z'))
		const replayPreProjection = await createDynamicCallableWorkflow({
			env: preProjectionEnv,
			userId: 'user-1',
			body: {
				code: 'export default async function main() { return { ok: true } }',
				idempotencyKey: 'inline-pre-projection-key',
			},
		})

		expect(replayPreProjection.id).toBe(firstPreProjection.id)
		expect(replayPreProjection.run_at).toBe(firstPreProjection.run_at)
		expect(preProjectionCreate).toHaveBeenCalledTimes(1)
		expect(preProjectionInstances.size).toBe(1)
	} finally {
		vi.useRealTimers()
	}

	const existingOverLimitBinding = createWorkflowBinding({})
	await expect(
		createDynamicCallableWorkflow({
			env: {
				APP_DB: createWorkflowRunsDatabase({ activeCount: 100 }),
				DYNAMIC_CALLABLE_WORKFLOWS: existingOverLimitBinding.workflow,
			} as Env,
			userId: 'user-1',
			body: {
				code: 'export default async function main() { return { ok: true } }',
				idempotencyKey: 'existing-over-limit-key',
			},
		}),
	).resolves.toMatchObject({
		ok: true,
		status: 'waiting',
	})
	expect(existingOverLimitBinding.create).not.toHaveBeenCalled()

	const failedCreateDb = createWorkflowRunsDatabase()
	const failedCreateInstances = new Map<string, WorkflowInstanceCreateOptions>()
	let shouldFailCreate = true
	const retryCreate = vi.fn(async (input: WorkflowInstanceCreateOptions) => {
		if (shouldFailCreate) {
			shouldFailCreate = false
			throw new Error('transient workflow create failure')
		}
		failedCreateInstances.set(input.id, input)
		return {
			id: input.id,
			status: async () => ({ status: 'queued' }),
		} as WorkflowInstance
	})
	const retryGet = vi.fn(async (id: string) => {
		if (!failedCreateInstances.has(id)) {
			throw new Error('workflow instance does not exist')
		}
		return {
			id,
			status: async () => ({ status: 'waiting' }),
		} as WorkflowInstance
	})
	const failedCreateEnv = {
		APP_DB: failedCreateDb,
		DYNAMIC_CALLABLE_WORKFLOWS: {
			get: retryGet,
			create: retryCreate,
		} as unknown as Workflow,
	} as Env
	vi.useFakeTimers()
	try {
		vi.setSystemTime(new Date('2026-05-08T19:30:00.000Z'))
		await expect(
			createDynamicCallableWorkflow({
				env: failedCreateEnv,
				userId: 'user-1',
				body: {
					code: 'export default async function main() { return { ok: true } }',
					idempotencyKey: 'failed-create-retry-key',
				},
			}),
		).rejects.toThrow('transient workflow create failure')
		expect([...failedCreateDb.workflowRuns.values()]).toEqual([
			expect.objectContaining({
				idempotency_key: 'failed-create-retry-key',
				run_at: '2026-05-08T19:30:00.000Z',
				status: 'creating',
			}),
		])
		vi.setSystemTime(new Date('2026-05-08T19:31:00.000Z'))
		const retryAfterFailure = await createDynamicCallableWorkflow({
			env: failedCreateEnv,
			userId: 'user-1',
			body: {
				code: 'export default async function main() { return { ok: true } }',
				idempotencyKey: 'failed-create-retry-key',
			},
		})

		expect(retryAfterFailure.run_at).toBe('2026-05-08T19:30:00.000Z')
		expect(retryCreate).toHaveBeenCalledTimes(2)
		expect([...failedCreateDb.workflowRuns.values()]).toEqual([
			expect.objectContaining({
				idempotency_key: 'failed-create-retry-key',
				run_at: '2026-05-08T19:30:00.000Z',
				status: 'queued',
			}),
		])
	} finally {
		vi.useRealTimers()
	}

	const perUserBinding = createStatefulWorkflowBinding()
	const userOne = await createDynamicCallableWorkflow({
		env: {
			APP_DB: createWorkflowRunsDatabase(),
			DYNAMIC_CALLABLE_WORKFLOWS: perUserBinding.workflow,
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
		env: {
			APP_DB: createWorkflowRunsDatabase({
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
			}),
			DYNAMIC_CALLABLE_WORKFLOWS: perUserBinding.workflow,
		} as Env,
		userId: 'user-2',
		body: {
			packageId: 'pkg-1',
			exportName: './workflow-run-event',
			runAt: '2026-05-08T19:30:00.000Z',
			idempotencyKey: 'shared-key',
		},
	})
	expect(userOne.id).not.toBe(userTwo.id)
	expect(perUserBinding.create).toHaveBeenCalledTimes(2)

	const erroredBinding = createStatefulWorkflowBinding()
	const erroredDb = createWorkflowRunsDatabase()
	const erroredEnv = {
		APP_DB: erroredDb,
		DYNAMIC_CALLABLE_WORKFLOWS: erroredBinding.workflow,
	} as Env
	const erroredFirst = await createDynamicCallableWorkflow({
		env: erroredEnv,
		userId: 'user-1',
		body: {
			packageId: 'pkg-1',
			exportName: './workflow-run-event',
			runAt: '2026-05-08T19:30:00.000Z',
			idempotencyKey: 'terminal-key',
		},
	})
	const erroredStored = erroredDb.workflowRuns.get(erroredFirst.id)
	if (!erroredStored) throw new Error('Expected stored workflow row.')
	erroredStored['status'] = 'errored'
	const erroredReplay = await createDynamicCallableWorkflow({
		env: erroredEnv,
		userId: 'user-1',
		body: {
			packageId: 'pkg-1',
			exportName: './workflow-run-event',
			runAt: '2026-05-08T19:31:00.000Z',
			idempotencyKey: 'terminal-key',
		},
	})
	expect(erroredReplay.id).toBe(erroredFirst.id)
	expect(erroredReplay.status).toBe('errored')
	expect(erroredBinding.create).toHaveBeenCalledTimes(1)
})

test('createDynamicCallableWorkflow enforces the per-user concurrent workflow limit', async () => {
	let error: unknown
	try {
		await createDynamicCallableWorkflow({
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
		})
	} catch (caught) {
		error = caught
	}
	expect(isEntitlementLimitError(error)).toBe(true)
	if (!isEntitlementLimitError(error)) {
		throw new Error(
			'Expected an EntitlementLimitError from createDynamicCallableWorkflow.',
		)
	}
	expect(error.message).toContain(
		'this deployment allows at most 100 concurrent workflows',
	)
	expect(error.details).toMatchObject({
		code: 'entitlement_limit_exceeded',
		resource: 'concurrent_workflows',
		plan: null,
		limit: 100,
	})
})

test('createDynamicCallableWorkflow enforces plan concurrent workflow limits', async () => {
	const email = 'plan-user@example.com'
	const userId = await createStableUserIdFromEmail(email)
	const limit = planLimits.personal.maxConcurrentWorkflows
	if (limit == null) throw new Error('Expected personal plan workflow limit.')
	const binding = createStatefulWorkflowBinding()
	const body = {
		code: 'export default async function main() { return { ok: true } }',
		runAt: '2026-05-03T12:34:56.000Z',
		idempotencyKey: 'plan-limit-key',
	}
	let denied: unknown
	try {
		await createDynamicCallableWorkflow({
			env: {
				APP_DB: createWorkflowRunsDatabase({
					activeCount: limit,
					users: [{ email, plan: 'personal' }],
				}),
				DYNAMIC_CALLABLE_WORKFLOWS: binding.workflow,
			} as Env,
			userId,
			userEmail: email,
			body,
		})
	} catch (caught) {
		denied = caught
	}
	expect(isEntitlementLimitError(denied)).toBe(true)
	if (!isEntitlementLimitError(denied)) {
		throw new Error(
			'Expected an EntitlementLimitError from createDynamicCallableWorkflow.',
		)
	}
	expect(denied.details).toMatchObject({
		code: 'entitlement_limit_exceeded',
		resource: 'concurrent_workflows',
		plan: 'personal',
		limit,
		current: limit,
	})
	expect(denied.message).toContain(`at most ${limit} concurrent workflows`)

	const allowed = await createDynamicCallableWorkflow({
		env: {
			APP_DB: createWorkflowRunsDatabase({
				activeCount: limit - 1,
				users: [{ email, plan: 'personal' }],
			}),
			DYNAMIC_CALLABLE_WORKFLOWS: createStatefulWorkflowBinding().workflow,
		} as Env,
		userId,
		userEmail: email,
		body: {
			...body,
			idempotencyKey: 'plan-limit-allowed-key',
		},
	})
	expect(allowed.ok).toBe(true)
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
	binding.instances.delete(created.id)
	const staleWorkflows = await listWorkflowRunsForUser({
		env,
		userId: 'user-1',
		limit: 10,
	})
	expect(staleWorkflows).toEqual([
		expect.objectContaining({
			id: created.id,
			status: 'queued',
			idempotencyKey: 'inline-key',
		}),
	])
})

test('DynamicCallableWorkflowBase records workflow_run usage on terminal transitions', async () => {
	const usageModule = await import('#worker/usage/record-usage.ts')
	const recordUsageSpy = vi
		.spyOn(usageModule, 'recordUsage')
		.mockResolvedValue(undefined)

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
			idempotencyKey: 'usage-metering-success',
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
	const workflow = new DynamicCallableWorkflowBase({} as ExecutionContext, env)
	const stepDo = vi.fn(
		async (_name: string, _config: unknown, callback: () => unknown) =>
			await callback(),
	)
	vi.useFakeTimers()
	try {
		vi.setSystemTime(new Date('2026-05-03T12:35:00.000Z'))
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
		expect(recordUsageSpy).toHaveBeenCalledTimes(1)
		expect(recordUsageSpy).toHaveBeenCalledWith(env, {
			userId: 'user-1',
			eventType: 'workflow_run',
			entityId: created.id,
			durationMs: expect.any(Number),
			outcome: 'success',
		})
		expect(
			recordUsageSpy.mock.calls[0]?.[1]?.durationMs,
		).toBeGreaterThanOrEqual(0)
	} finally {
		vi.useRealTimers()
	}

	recordUsageSpy.mockClear()
	const failedBinding = createStatefulWorkflowBinding()
	const failedDb = createWorkflowRunsDatabase()
	const failedEnv = {
		APP_DB: failedDb,
		DYNAMIC_CALLABLE_WORKFLOWS: failedBinding.workflow,
		APP_BASE_URL: 'https://app.example.com',
	} as Env
	const failedCreated = await createDynamicCallableWorkflow({
		env: failedEnv,
		userId: 'user-1',
		packageContext: null,
		body: {
			code: 'export default async function main(){ throw new Error("workflow failed"); }',
			runAt: '2026-05-03T12:34:56.000Z',
			idempotencyKey: 'usage-metering-failure',
		},
	})
	const failedQueued = failedBinding.instances.get(failedCreated.id)
	if (!failedQueued?.params)
		throw new Error('Expected queued workflow payload.')
	invocationMocks.runModuleWithRegistry.mockReset()
	invocationMocks.runModuleWithRegistry.mockRejectedValueOnce(
		new Error('workflow failed'),
	)
	const failedWorkflow = new DynamicCallableWorkflowBase(
		{} as ExecutionContext,
		failedEnv,
	)
	await expect(
		failedWorkflow.run(
			{
				payload: failedQueued.params as never,
				timestamp: new Date(),
				instanceId: failedCreated.id,
			},
			{ sleepUntil: vi.fn(), do: stepDo } as unknown as WorkflowStep,
		),
	).rejects.toThrow('workflow failed')
	expect(recordUsageSpy).toHaveBeenCalledTimes(1)
	expect(recordUsageSpy).toHaveBeenCalledWith(failedEnv, {
		userId: 'user-1',
		eventType: 'workflow_run',
		entityId: failedCreated.id,
		durationMs: expect.any(Number),
		outcome: 'error',
	})
	expect(recordUsageSpy.mock.calls[0]?.[1]?.durationMs).toBeGreaterThanOrEqual(
		0,
	)
	expect(failedDb.workflowRuns.get(failedCreated.id)).toMatchObject({
		status: 'errored',
		last_error: 'workflow failed',
	})

	recordUsageSpy.mockRestore()
})

test('workflow_run usage is recorded once across replays and never on failed terminal status writes', async () => {
	const usageModule = await import('#worker/usage/record-usage.ts')
	const recordUsageSpy = vi
		.spyOn(usageModule, 'recordUsage')
		.mockResolvedValue(undefined)

	function createReplayableStep() {
		const cachedResults = new Map<string, unknown>()
		return {
			sleepUntil: vi.fn(),
			do: vi.fn(
				async (name: string, _config: unknown, callback: () => unknown) => {
					if (cachedResults.has(name)) return cachedResults.get(name)
					const value = await callback()
					cachedResults.set(name, value)
					return value
				},
			),
		}
	}

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
			idempotencyKey: 'usage-metering-replay',
		},
	})
	const queued = binding.instances.get(created.id)
	if (!queued?.params) throw new Error('Expected queued workflow payload.')
	invocationMocks.runModuleWithRegistry.mockReset()
	invocationMocks.runModuleWithRegistry.mockResolvedValue({
		result: { ok: true },
		logs: [],
	})
	const workflow = new DynamicCallableWorkflowBase({} as ExecutionContext, env)
	const replayableStep = createReplayableStep()
	const runEvent = {
		payload: queued.params as never,
		timestamp: new Date(),
		instanceId: created.id,
	}

	try {
		// First entry plus a replay: completed steps return cached results, so the
		// usage event is recorded exactly once.
		await workflow.run(runEvent, replayableStep as unknown as WorkflowStep)
		await workflow.run(runEvent, replayableStep as unknown as WorkflowStep)
		expect(recordUsageSpy).toHaveBeenCalledTimes(1)
		expect(recordUsageSpy).toHaveBeenCalledWith(
			env,
			expect.objectContaining({
				eventType: 'workflow_run',
				entityId: created.id,
				outcome: 'success',
			}),
		)

		// A successful execution whose terminal status write fails must not be
		// recorded as an error (and is not recorded at all until the terminal
		// transition succeeds on a later replay).
		recordUsageSpy.mockClear()
		const statusFailureDb = createWorkflowRunsDatabase()
		const statusFailureEnv = {
			APP_DB: new Proxy(statusFailureDb, {
				get(target, property, receiver) {
					if (property !== 'prepare') {
						return Reflect.get(target, property, receiver)
					}
					return (query: string) => {
						const statement = target.prepare(query)
						if (!query.includes('INSERT INTO workflow_runs')) return statement
						return {
							bind(...params: Array<unknown>) {
								if (params[11] === 'complete') {
									return {
										async run() {
											throw new Error('terminal status write failed')
										},
									}
								}
								return statement.bind(...params)
							},
						}
					}
				},
			}) as unknown as D1Database,
			DYNAMIC_CALLABLE_WORKFLOWS: binding.workflow,
			APP_BASE_URL: 'https://app.example.com',
		} as Env
		const statusFailureCreated = await createDynamicCallableWorkflow({
			env: statusFailureEnv,
			userId: 'user-1',
			packageContext: null,
			body: {
				code: 'export default async function main(){ return { ok: true }; }',
				runAt: '2026-05-03T12:34:56.000Z',
				idempotencyKey: 'usage-metering-status-write-failure',
			},
		})
		const statusFailureQueued = binding.instances.get(statusFailureCreated.id)
		if (!statusFailureQueued?.params) {
			throw new Error('Expected queued workflow payload.')
		}
		const statusFailureWorkflow = new DynamicCallableWorkflowBase(
			{} as ExecutionContext,
			statusFailureEnv,
		)
		await expect(
			statusFailureWorkflow.run(
				{
					payload: statusFailureQueued.params as never,
					timestamp: new Date(),
					instanceId: statusFailureCreated.id,
				},
				createReplayableStep() as unknown as WorkflowStep,
			),
		).rejects.toThrow('terminal status write failed')
		expect(recordUsageSpy).not.toHaveBeenCalled()
	} finally {
		recordUsageSpy.mockRestore()
	}
})
