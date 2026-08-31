import { expect, test, vi } from 'vitest'
import {} from '#worker/package-runtime/workflow-statuses.ts'
import { type WorkflowProjectionUpsertInput } from '#worker/run-records/service.ts'
import {
	DynamicCallableWorkflowBase,
	createDynamicCallableWorkflow,
	dynamicCallableWorkflowsBindingName,
	workflowExecutorTimeoutMs,
} from './package-workflows.ts'
import {
	packageWorkflowsInvocationMocks as invocationMocks,
	packageWorkflowsRunRecordMocks as runRecordMocks,
	createWorkflowBinding,
	createStatefulWorkflowBinding,
	createWorkflowRunsDatabase,
} from '#worker/test-support/package-workflows.ts'

vi.mock('#worker/package-invocations/service.ts', () => ({
	invokePackageExport: (...args: Array<unknown>) =>
		invocationMocks.invokePackageExport(...args),
	createExecutePackageInvokeTools: (...args: Array<unknown>) =>
		invocationMocks.createExecutePackageInvokeTools(...args),
	createPackageRuntimeInvokeTools: (...args: Array<unknown>) =>
		invocationMocks.createPackageRuntimeInvokeTools(...args),
}))

vi.mock('#mcp/run-kody-registry.ts', () => ({
	runModuleWithRegistry: (...args: Array<unknown>) =>
		invocationMocks.runModuleWithRegistry(...args),
}))

vi.mock('#worker/identity/background-mcp-user.ts', () => ({
	resolveBackgroundMcpUser: async (_db: D1Database, userId: string) => ({
		userId,
		email: `${userId}@example.com`,
		username: userId,
		displayName: userId,
	}),
}))

vi.mock('#worker/run-records/service.ts', () => ({
	beginRunRecord: (...args: Array<unknown>) =>
		runRecordMocks.beginRunRecord(...args),
	finishRunRecord: (...args: Array<unknown>) =>
		runRecordMocks.finishRunRecord(...args),
	upsertWorkflowProjection: (...args: Array<unknown>) =>
		runRecordMocks.upsertWorkflowProjection(
			...(args as [
				{
					env: Env
					userId: string
					projection: WorkflowProjectionUpsertInput
				},
			]),
		),
	getWorkflowProjection: (...args: Array<unknown>) =>
		runRecordMocks.getWorkflowProjection(
			...(args as [{ env: Env; userId: string; id: string }]),
		),
	findWorkflowProjectionByIdempotencyKey: (...args: Array<unknown>) =>
		runRecordMocks.findWorkflowProjectionByIdempotencyKey(
			...(args as [
				{
					env: Env
					userId: string
					idempotencyKey: string
					bindingName?: string | null
				},
			]),
		),
	listWorkflowProjections: (...args: Array<unknown>) =>
		runRecordMocks.listWorkflowProjections(
			...(args as [
				{
					env: Env
					userId: string
					limit?: number | null
					cursor?: string | null
					status?: string | null
					bindingName?: string | null
				},
			]),
		),
	countActiveWorkflowProjections: (...args: Array<unknown>) =>
		runRecordMocks.countActiveWorkflowProjections(
			...(args as [{ env: Env; userId: string }]),
		),
	reserveWorkflowProjectionSlot: (...args: Array<unknown>) =>
		runRecordMocks.reserveWorkflowProjectionSlot(
			...(args as [
				{
					env: Env
					userId: string
					projection: WorkflowProjectionUpsertInput
				},
			]),
		),
	deleteWorkflowProjectionIfCreating: (...args: Array<unknown>) =>
		runRecordMocks.deleteWorkflowProjectionIfCreating(
			...(args as [{ env: Env; userId: string; id: string }]),
		),
}))

test('createDynamicCallableWorkflow queues inline code without package context and records runs before status reads', async () => {
	runRecordMocks.resetProjections()
	const binding = createStatefulWorkflowBinding()
	const db = createWorkflowRunsDatabase()

	const created = await createDynamicCallableWorkflow({
		env: {
			APP_DB: db,
			DYNAMIC_CALLABLE_WORKFLOWS: binding.workflow,
			RUN_LOG: {} as DurableObjectNamespace,
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
	expect(runRecordMocks.listForUser('user-1')).toEqual([
		expect.objectContaining({
			id: created.id,
			bindingName: dynamicCallableWorkflowsBindingName,
			status: 'queued',
			idempotencyKey: 'inline-key',
		}),
	])

	runRecordMocks.resetProjections()
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
				RUN_LOG: {} as DurableObjectNamespace,
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
	expect(runRecordMocks.listForUser('user-1')).toEqual([
		expect.objectContaining({
			status: 'queued',
			idempotencyKey: 'status-failure-key',
			bindingName: dynamicCallableWorkflowsBindingName,
		}),
	])
})

test('DynamicCallableWorkflowBase executes queued inline code and records completion', async () => {
	runRecordMocks.resetProjections()
	const binding = createStatefulWorkflowBinding()
	const db = createWorkflowRunsDatabase()
	const env = {
		APP_DB: db,
		DYNAMIC_CALLABLE_WORKFLOWS: binding.workflow,
		APP_BASE_URL: 'https://app.example.com',
	} as Env
	vi.useFakeTimers()
	try {
		// Create and complete under ordered clocks so monotonic upsert accepts
		// the terminal projection (lagging timestamps must not regress status).
		vi.setSystemTime(new Date('2026-05-03T12:34:56.000Z'))
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
		const packageInvokeTools = { invoke: vi.fn() }
		invocationMocks.createExecutePackageInvokeTools.mockReset()
		invocationMocks.createExecutePackageInvokeTools.mockReturnValueOnce(
			packageInvokeTools,
		)
		invocationMocks.createPackageRuntimeInvokeTools.mockReset()
		vi.setSystemTime(new Date('2026-05-03T12:35:00.000Z'))
		const workflow = new DynamicCallableWorkflowBase(
			{ waitUntil: vi.fn() } as unknown as ExecutionContext,
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
		expect(
			invocationMocks.createExecutePackageInvokeTools,
		).toHaveBeenCalledWith({
			env: expect.objectContaining({
				APP_BASE_URL: 'https://app.example.com',
			}),
			baseUrl: 'https://app.example.com',
			callerContext: expect.objectContaining({
				executionOrigin: 'background',
				user: expect.objectContaining({ userId: 'user-1' }),
			}),
			waitUntil: expect.any(Function),
		})
		expect(
			invocationMocks.createPackageRuntimeInvokeTools,
		).not.toHaveBeenCalled()
		expect(invocationMocks.runModuleWithRegistry).toHaveBeenCalledWith(
			expect.objectContaining({ APP_BASE_URL: 'https://app.example.com' }),
			expect.objectContaining({
				executionOrigin: 'background',
				user: expect.objectContaining({ userId: 'user-1' }),
			}),
			'export default async function main(p){ return { ok: true, p }; }',
			{ greeting: 'hello' },
			{
				packageContext: null,
				packageInvokeTools,
				executorTimeoutMs: workflowExecutorTimeoutMs,
			},
		)
		expect(
			runRecordMocks.listForUser('user-1').find((row) => row.id === created.id),
		).toMatchObject({
			status: 'complete',
			completedAt: expect.any(String),
			bindingName: dynamicCallableWorkflowsBindingName,
		})
	} finally {
		vi.useRealTimers()
	}
})

test('inline workflow sandbox failures throw UserCodeError', async () => {
	const { UserCodeError, isUserCodeError } =
		await import('#worker/user-code-error.ts')
	runRecordMocks.resetProjections()
	runRecordMocks.beginRunRecord.mockClear()
	runRecordMocks.finishRunRecord.mockClear()
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
			code: 'export default async function main(){ throw new Error("boom"); }',
			runAt: '2026-05-03T12:34:56.000Z',
			idempotencyKey: 'inline-user-code-error',
		},
	})
	const queued = binding.instances.get(created.id)
	if (!queued?.params) throw new Error('Expected queued workflow payload.')
	invocationMocks.runModuleWithRegistry.mockReset()
	invocationMocks.runModuleWithRegistry.mockResolvedValueOnce({
		result: undefined,
		error: 'boom',
		logs: ['[error] boom'],
	})
	const workflow = new DynamicCallableWorkflowBase(
		{ waitUntil: vi.fn() } as unknown as ExecutionContext,
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
	).rejects.toSatisfy(
		(error: unknown) =>
			error instanceof UserCodeError &&
			error.message === 'boom' &&
			isUserCodeError(error),
	)
	expect(
		runRecordMocks.listForUser('user-1').find((row) => row.id === created.id),
	).toMatchObject({
		status: 'errored',
		lastError: 'boom',
		bindingName: dynamicCallableWorkflowsBindingName,
	})
	expect(runRecordMocks.beginRunRecord).toHaveBeenCalledWith(
		expect.objectContaining({
			userId: 'user-1',
			context: expect.objectContaining({
				surface: 'workflow',
				workflowId: created.id,
				storageId: null,
				metadata: { sourceType: 'inline' },
			}),
		}),
	)
	const beginContext = runRecordMocks.beginRunRecord.mock.calls.at(-1)?.[0]
		?.context as { packageId?: string } | undefined
	expect(beginContext?.packageId).toBeUndefined()
	expect(runRecordMocks.finishRunRecord).toHaveBeenCalledWith(
		expect.objectContaining({
			status: 'error',
			logs: ['[error] boom'],
			error: expect.any(UserCodeError),
		}),
	)
})

test('inline workflow Durable Object isolate resets are not UserCodeError', async () => {
	const { UserCodeError } = await import('#worker/user-code-error.ts')
	runRecordMocks.resetProjections()
	runRecordMocks.beginRunRecord.mockClear()
	runRecordMocks.finishRunRecord.mockClear()
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
			code: 'export default async function main(){ return 1 }',
			runAt: '2026-05-03T12:34:56.000Z',
			idempotencyKey: 'inline-durable-object-reset',
		},
	})
	const queued = binding.instances.get(created.id)
	if (!queued?.params) throw new Error('Expected queued workflow payload.')
	invocationMocks.runModuleWithRegistry.mockReset()
	invocationMocks.runModuleWithRegistry.mockResolvedValueOnce({
		result: undefined,
		error: 'Durable Object reset because its code was updated.',
		logs: [],
	})
	const workflow = new DynamicCallableWorkflowBase(
		{ waitUntil: vi.fn() } as unknown as ExecutionContext,
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
	).rejects.toSatisfy(
		(error: unknown) =>
			error instanceof Error &&
			!(error instanceof UserCodeError) &&
			error.message === 'Durable Object reset because its code was updated.',
	)
	const finishError =
		runRecordMocks.finishRunRecord.mock.calls.at(-1)?.[0]?.error
	expect(finishError).toBeInstanceOf(Error)
	expect(finishError).not.toBeInstanceOf(UserCodeError)
})

test('package-created inline workflows retain package secret authorization context', async () => {
	runRecordMocks.resetProjections()
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
	const packageInvokeTools = { invoke: vi.fn() }
	invocationMocks.createPackageRuntimeInvokeTools.mockReset()
	invocationMocks.createPackageRuntimeInvokeTools.mockReturnValueOnce(
		packageInvokeTools,
	)
	invocationMocks.createExecutePackageInvokeTools.mockReset()
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

	expect(invocationMocks.createPackageRuntimeInvokeTools).toHaveBeenCalledWith({
		env: expect.any(Object),
		baseUrl: 'https://app.example.com',
		callerContext: expect.objectContaining({
			storageContext: {
				sessionId: null,
				appId: 'package-1',
				packageId: 'package-1',
				storageId: null,
			},
		}),
		packageContext,
		waitUntil: expect.any(Function),
	})
	expect(invocationMocks.createExecutePackageInvokeTools).not.toHaveBeenCalled()
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
		{
			packageContext,
			packageInvokeTools,
			executorTimeoutMs: workflowExecutorTimeoutMs,
		},
	)
})

test('DynamicCallableWorkflowBase marks package export error responses as workflow errors', async () => {
	runRecordMocks.resetProjections()
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
					'Shade workflow event failed: Tool "kody.mcp[\\"home\\"].bond_shade_set_position" not found',
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
	).rejects.toThrow('kody.mcp[\\"home\\"].bond_shade_set_position')
	expect(
		runRecordMocks.listForUser('user-1').find((row) => row.id === created.id),
	).toMatchObject({
		status: 'errored',
		completedAt: expect.any(String),
		lastError: expect.stringContaining(
			'kody.mcp[\\"home\\"].bond_shade_set_position',
		),
	})
})

test('DynamicCallableWorkflowBase rejects package export redirect responses', async () => {
	runRecordMocks.resetProjections()
	runRecordMocks.beginRunRecord.mockClear()
	runRecordMocks.finishRunRecord.mockClear()
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

	const workflow = new DynamicCallableWorkflowBase(
		{ waitUntil: vi.fn() } as unknown as ExecutionContext,
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
	).rejects.toThrow('Package workflow export failed with HTTP 302.')
	expect(
		runRecordMocks.listForUser('user-1').find((row) => row.id === created.id),
	).toMatchObject({
		status: 'errored',
		completedAt: expect.any(String),
		lastError: 'Package workflow export failed with HTTP 302.',
	})
	const { UserCodeError } = await import('#worker/user-code-error.ts')
	expect(runRecordMocks.beginRunRecord).toHaveBeenCalledWith(
		expect.objectContaining({
			context: expect.objectContaining({
				surface: 'workflow',
				packageId: 'pkg-1',
				workflowId: created.id,
			}),
		}),
	)
	const finishError =
		runRecordMocks.finishRunRecord.mock.calls.at(-1)?.[0]?.error
	expect(finishError).toBeInstanceOf(Error)
	expect(finishError).not.toBeInstanceOf(UserCodeError)
})

test('package workflow records exactly one workflow run with workflowId', async () => {
	runRecordMocks.resetProjections()
	runRecordMocks.beginRunRecord.mockClear()
	runRecordMocks.finishRunRecord.mockClear()
	const binding = createStatefulWorkflowBinding()
	const env = {
		APP_DB: createWorkflowRunsDatabase(),
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
			workflowName: 'shade-event',
			runAt: '2026-05-03T12:34:56.000Z',
			idempotencyKey: 'package-single-run-record',
			params: { key: 'north' },
		},
	})
	const queued = binding.instances.get(created.id)
	if (!queued?.params) throw new Error('Expected queued workflow payload.')
	invocationMocks.invokePackageExport.mockReset()
	invocationMocks.invokePackageExport.mockResolvedValueOnce({
		status: 200,
		body: { result: { ok: true } },
	})
	const stepDo = vi.fn(
		async (_name: string, _config: unknown, callback: () => unknown) =>
			await callback(),
	)
	await new DynamicCallableWorkflowBase(
		{ waitUntil: vi.fn() } as unknown as ExecutionContext,
		env,
	).run(
		{
			payload: queued.params as never,
			timestamp: new Date(),
			instanceId: created.id,
		},
		{ sleepUntil: vi.fn(), do: stepDo } as unknown as WorkflowStep,
	)
	expect(runRecordMocks.beginRunRecord).toHaveBeenCalledTimes(1)
	expect(runRecordMocks.beginRunRecord).toHaveBeenCalledWith(
		expect.objectContaining({
			userId: 'user-1',
			context: expect.objectContaining({
				surface: 'workflow',
				name: 'shade-event',
				packageId: 'pkg-1',
				workflowId: created.id,
				metadata: {
					sourceType: 'package',
					exportName: './workflow-run-event',
				},
			}),
		}),
	)
	expect(runRecordMocks.finishRunRecord).toHaveBeenCalledTimes(1)
	expect(runRecordMocks.finishRunRecord).toHaveBeenCalledWith(
		expect.objectContaining({ status: 'success' }),
	)
	expect(invocationMocks.invokePackageExport).toHaveBeenCalledWith(
		expect.objectContaining({
			request: expect.objectContaining({
				source: 'package-workflow',
			}),
		}),
	)
})

test('inline workflow records exactly one workflow run with workflowId', async () => {
	runRecordMocks.resetProjections()
	runRecordMocks.beginRunRecord.mockClear()
	runRecordMocks.finishRunRecord.mockClear()
	const binding = createStatefulWorkflowBinding()
	const env = {
		APP_DB: createWorkflowRunsDatabase(),
		DYNAMIC_CALLABLE_WORKFLOWS: binding.workflow,
		APP_BASE_URL: 'https://app.example.com',
	} as Env
	const created = await createDynamicCallableWorkflow({
		env,
		userId: 'user-1',
		packageContext: null,
		body: {
			code: 'export default async function main(){ return { ok: true }; }',
			workflowName: 'inline-once',
			runAt: '2026-05-03T12:34:56.000Z',
			idempotencyKey: 'inline-single-run-record',
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
	await new DynamicCallableWorkflowBase(
		{ waitUntil: vi.fn() } as unknown as ExecutionContext,
		env,
	).run(
		{
			payload: queued.params as never,
			timestamp: new Date(),
			instanceId: created.id,
		},
		{ sleepUntil: vi.fn(), do: stepDo } as unknown as WorkflowStep,
	)
	expect(runRecordMocks.beginRunRecord).toHaveBeenCalledTimes(1)
	expect(runRecordMocks.beginRunRecord).toHaveBeenCalledWith(
		expect.objectContaining({
			context: expect.objectContaining({
				surface: 'workflow',
				name: 'inline-once',
				workflowId: created.id,
				metadata: { sourceType: 'inline' },
			}),
		}),
	)
	expect(runRecordMocks.finishRunRecord).toHaveBeenCalledTimes(1)
	expect(runRecordMocks.finishRunRecord).toHaveBeenCalledWith(
		expect.objectContaining({ status: 'success' }),
	)
})

test('package workflow sandbox and 4xx failures throw UserCodeError', async () => {
	runRecordMocks.resetProjections()
	const { UserCodeError, isUserCodeError } =
		await import('#worker/user-code-error.ts')
	const cases = [
		{
			idempotencyKey: 'package-execution-failed-user-code',
			response: {
				status: 500,
				body: {
					ok: false,
					error: {
						code: 'execution_failed',
						message: 'boom from user package',
					},
				},
			},
			message: 'boom from user package',
		},
		{
			idempotencyKey: 'package-export-not-found-user-code',
			response: {
				status: 404,
				body: {
					ok: false,
					error: {
						code: 'export_not_found',
						message: 'Export "./missing" was not found.',
					},
				},
			},
			message: 'Export "./missing" was not found.',
		},
	] as const

	for (const testCase of cases) {
		runRecordMocks.beginRunRecord.mockClear()
		runRecordMocks.finishRunRecord.mockClear()
		const binding = createStatefulWorkflowBinding()
		const env = {
			APP_DB: createWorkflowRunsDatabase(),
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
				idempotencyKey: testCase.idempotencyKey,
			},
		})
		const queued = binding.instances.get(created.id)
		if (!queued?.params) throw new Error('Expected queued workflow payload.')
		invocationMocks.invokePackageExport.mockReset()
		invocationMocks.invokePackageExport.mockResolvedValueOnce(testCase.response)
		const stepDo = vi.fn(
			async (_name: string, _config: unknown, callback: () => unknown) =>
				await callback(),
		)
		await expect(
			new DynamicCallableWorkflowBase(
				{ waitUntil: vi.fn() } as unknown as ExecutionContext,
				env,
			).run(
				{
					payload: queued.params as never,
					timestamp: new Date(),
					instanceId: created.id,
				},
				{ sleepUntil: vi.fn(), do: stepDo } as unknown as WorkflowStep,
			),
		).rejects.toSatisfy(
			(error: unknown) =>
				error instanceof UserCodeError &&
				error.message === testCase.message &&
				isUserCodeError(error),
		)
		expect(runRecordMocks.finishRunRecord).toHaveBeenCalledWith(
			expect.objectContaining({
				status: 'error',
				error: expect.any(UserCodeError),
			}),
		)
	}
})

test('package workflow infrastructure failures are not UserCodeError', async () => {
	runRecordMocks.resetProjections()
	const { UserCodeError } = await import('#worker/user-code-error.ts')
	const cases = [
		{
			idempotencyKey: 'package-artifact-prep-infra',
			response: {
				status: 503,
				body: {
					ok: false,
					error: {
						code: 'artifact_preparation_failed',
						message: 'Package artifact preparation failed before execution.',
					},
				},
			},
			message: 'Package artifact preparation failed before execution.',
		},
		{
			idempotencyKey: 'package-invocation-failed-infra',
			response: {
				status: 500,
				body: {
					ok: false,
					error: {
						code: 'invocation_failed',
						message: 'Durable Object storage blew up.',
					},
				},
			},
			message: 'Durable Object storage blew up.',
		},
		{
			idempotencyKey: 'package-durable-object-reset-infra',
			response: {
				status: 503,
				body: {
					ok: false,
					error: {
						code: 'durable_object_reset',
						message: 'Durable Object reset because its code was updated.',
					},
				},
			},
			message: 'Durable Object reset because its code was updated.',
		},
	] as const

	for (const testCase of cases) {
		runRecordMocks.beginRunRecord.mockClear()
		runRecordMocks.finishRunRecord.mockClear()
		const binding = createStatefulWorkflowBinding()
		const env = {
			APP_DB: createWorkflowRunsDatabase(),
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
				idempotencyKey: testCase.idempotencyKey,
			},
		})
		const queued = binding.instances.get(created.id)
		if (!queued?.params) throw new Error('Expected queued workflow payload.')
		invocationMocks.invokePackageExport.mockReset()
		invocationMocks.invokePackageExport.mockResolvedValueOnce(testCase.response)
		const stepDo = vi.fn(
			async (_name: string, _config: unknown, callback: () => unknown) =>
				await callback(),
		)
		await expect(
			new DynamicCallableWorkflowBase(
				{ waitUntil: vi.fn() } as unknown as ExecutionContext,
				env,
			).run(
				{
					payload: queued.params as never,
					timestamp: new Date(),
					instanceId: created.id,
				},
				{ sleepUntil: vi.fn(), do: stepDo } as unknown as WorkflowStep,
			),
		).rejects.toSatisfy(
			(error: unknown) =>
				error instanceof Error &&
				!(error instanceof UserCodeError) &&
				error.message === testCase.message,
		)
		const finishError =
			runRecordMocks.finishRunRecord.mock.calls.at(-1)?.[0]?.error
		expect(finishError).toBeInstanceOf(Error)
		expect(finishError).not.toBeInstanceOf(UserCodeError)
	}
})
