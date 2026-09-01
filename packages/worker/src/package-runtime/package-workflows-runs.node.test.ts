import { expect, test, vi } from 'vitest'
import { isEntitlementLimitError } from '#worker/entitlements/errors.ts'
import { planLimits } from '#universal/plans.ts'
import { activeWorkflowStatusValues } from '#worker/package-runtime/workflow-statuses.ts'
import { creatingWorkflowProjectionStatus } from '#worker/run-records/workflow-projection.ts'
import {
	type WorkflowProjectionRecord,
	type WorkflowProjectionUpsertInput,
} from '#worker/run-records/service.ts'
import { createStableUserIdFromEmail } from '#worker/user-id.ts'
import {
	DynamicCallableWorkflowBase,
	cancelWorkflowRunForUser,
	createDynamicCallableWorkflow,
	dynamicCallableWorkflowsBindingName,
	listWorkflowRunsForUser,
} from './package-workflows.ts'
import {
	packageWorkflowsInvocationMocks as invocationMocks,
	packageWorkflowsRunRecordMocks as runRecordMocks,
	seedActiveWorkflowProjections,
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

test('createDynamicCallableWorkflow verifies package ownership before queueing package exports', async () => {
	runRecordMocks.resetProjections()
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
				RUN_LOG: {} as DurableObjectNamespace,
			} as Env,
			userId: 'user-1',
			body: {
				packageId: 'not-owned',
				exportName: './run-event',
				runAt: '2026-05-03T12:34:56.000Z',
				// Distinct key: same-key replay is satisfied from the user-scoped
				// RunLog projection before package ownership is resolved.
				idempotencyKey: 'not-owned-key',
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
	runRecordMocks.resetProjections()
	const binding = createStatefulWorkflowBinding()
	const db = createWorkflowRunsDatabase()
	const env = {
		APP_DB: db,
		DYNAMIC_CALLABLE_WORKFLOWS: binding.workflow,
		RUN_LOG: {} as DurableObjectNamespace,
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
	expect(runRecordMocks.listForUser('user-1')).toEqual([
		expect.objectContaining({
			idempotencyKey: 'idempotency-repro',
			runAt: '2026-05-08T19:30:00.000Z',
			bindingName: dynamicCallableWorkflowsBindingName,
		}),
	])
	runRecordMocks.resetProjections()
	const preProjectionDb = createWorkflowRunsDatabase()
	const preProjectionInstances = new Map<
		string,
		WorkflowInstanceCreateOptions
	>()
	const preProjectionCreate = vi.fn(
		async (input: WorkflowInstanceCreateOptions) => {
			expect(runRecordMocks.listForUser('user-1')).toEqual([
				expect.objectContaining({
					id: input.id,
					idempotencyKey: 'inline-pre-projection-key',
					runAt: '2026-05-08T19:30:00.000Z',
					status: creatingWorkflowProjectionStatus,
					bindingName: dynamicCallableWorkflowsBindingName,
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
		RUN_LOG: {} as DurableObjectNamespace,
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

	runRecordMocks.resetProjections()
	const existingOverLimitBinding = createWorkflowBinding({})
	await seedActiveWorkflowProjections({ userId: 'user-1', count: 100 })
	// Existing engine instance must still short-circuit before entitlement.
	await expect(
		createDynamicCallableWorkflow({
			env: {
				APP_DB: createWorkflowRunsDatabase(),
				DYNAMIC_CALLABLE_WORKFLOWS: existingOverLimitBinding.workflow,
				RUN_LOG: {} as DurableObjectNamespace,
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

	runRecordMocks.resetProjections()
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
		RUN_LOG: {} as DurableObjectNamespace,
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
		// Non-duplicate engine failures release the creating reservation.
		expect(runRecordMocks.listForUser('user-1')).toEqual([])
		expect(runRecordMocks.deleteWorkflowProjectionIfCreating).toHaveBeenCalled()
		vi.setSystemTime(new Date('2026-05-08T19:31:00.000Z'))
		const retryAfterFailure = await createDynamicCallableWorkflow({
			env: failedCreateEnv,
			userId: 'user-1',
			body: {
				code: 'export default async function main() { return { ok: true } }',
				idempotencyKey: 'failed-create-retry-key',
			},
		})

		expect(retryAfterFailure.run_at).toBe('2026-05-08T19:31:00.000Z')
		expect(retryCreate).toHaveBeenCalledTimes(2)
		expect(runRecordMocks.listForUser('user-1')).toEqual([
			expect.objectContaining({
				idempotencyKey: 'failed-create-retry-key',
				runAt: '2026-05-08T19:31:00.000Z',
				status: 'queued',
			}),
		])
	} finally {
		vi.useRealTimers()
	}

	runRecordMocks.resetProjections()
	const perUserBinding = createStatefulWorkflowBinding()
	const userOne = await createDynamicCallableWorkflow({
		env: {
			APP_DB: createWorkflowRunsDatabase(),
			DYNAMIC_CALLABLE_WORKFLOWS: perUserBinding.workflow,
			RUN_LOG: {} as DurableObjectNamespace,
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
			RUN_LOG: {} as DurableObjectNamespace,
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

	runRecordMocks.resetProjections()
	const erroredBinding = createStatefulWorkflowBinding()
	const erroredEnv = {
		APP_DB: createWorkflowRunsDatabase(),
		DYNAMIC_CALLABLE_WORKFLOWS: erroredBinding.workflow,
		RUN_LOG: {} as DurableObjectNamespace,
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
	const erroredStored = runRecordMocks
		.listForUser('user-1')
		.find((row) => row.id === erroredFirst.id)
	if (!erroredStored) throw new Error('Expected stored workflow projection.')
	erroredStored.status = 'errored'
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

test('RunLog-only list, cancel, idempotency, and concurrency stay D1-free', async () => {
	runRecordMocks.resetProjections()
	const freeLimit = planLimits.free.maxConcurrentWorkflows
	const binding = createStatefulWorkflowBinding()
	const db = createWorkflowRunsDatabase()
	const env = {
		APP_DB: db,
		DYNAMIC_CALLABLE_WORKFLOWS: binding.workflow,
		RUN_LOG: {} as DurableObjectNamespace,
	} as Env

	const now = '2026-05-08T18:00:00.000Z'
	const activeIds = Array.from(
		{ length: freeLimit },
		(_, index) => `dynwf-active-${index}`,
	)
	const doneId = 'dynwf-done'
	const idemId = 'dynwf-idem'
	for (const [index, id] of activeIds.entries()) {
		await runRecordMocks.upsertWorkflowProjection({
			env,
			userId: 'user-1',
			projection: {
				id,
				bindingName: dynamicCallableWorkflowsBindingName,
				sourceType: 'inline',
				workflowName: 'inline-code',
				idempotencyKey: `active-${index}`,
				runAt: now,
				planDate: '2026-05-08',
				status: 'running',
				createdAt: now,
				updatedAt: now,
			},
		})
		binding.instances.set(id, { id } as WorkflowInstanceCreateOptions)
	}
	await runRecordMocks.upsertWorkflowProjection({
		env,
		userId: 'user-1',
		projection: {
			id: doneId,
			bindingName: dynamicCallableWorkflowsBindingName,
			sourceType: 'inline',
			workflowName: 'inline-code',
			idempotencyKey: 'done-key',
			runAt: now,
			planDate: '2026-05-08',
			status: 'complete',
			createdAt: now,
			updatedAt: now,
			completedAt: now,
		},
	})
	await runRecordMocks.upsertWorkflowProjection({
		env,
		userId: 'user-1',
		projection: {
			id: idemId,
			bindingName: dynamicCallableWorkflowsBindingName,
			sourceType: 'inline',
			workflowName: 'inline-code',
			idempotencyKey: 'idem-key',
			runAt: now,
			planDate: '2026-05-08',
			status: 'complete',
			createdAt: now,
			updatedAt: now,
			completedAt: now,
		},
	})

	const listed = await listWorkflowRunsForUser({
		env,
		userId: 'user-1',
		limit: 25,
	})
	expect(listed.map((row) => row.id).sort()).toEqual(
		[...activeIds, doneId, idemId].sort(),
	)

	const replay = await createDynamicCallableWorkflow({
		env,
		userId: 'user-1',
		body: {
			code: 'export default async function main() { return { ok: true } }',
			idempotencyKey: 'idem-key',
			runAt: '2026-05-08T19:30:00.000Z',
		},
	})
	expect(replay.id).toBe(idemId)
	expect(replay.status).toBe('complete')
	expect(binding.create).not.toHaveBeenCalled()

	await expect(
		createDynamicCallableWorkflow({
			env,
			userId: 'user-1',
			body: {
				code: 'export default async function main() { return { ok: true } }',
				idempotencyKey: 'blocked-by-active',
				runAt: '2026-05-08T19:30:00.000Z',
			},
		}),
	).rejects.toSatisfy((error: unknown) => isEntitlementLimitError(error))
	expect(binding.create).not.toHaveBeenCalled()

	const cancelled = await cancelWorkflowRunForUser({
		env,
		userId: 'user-1',
		workflowRunId: activeIds[0]!,
	})
	expect(cancelled).toMatchObject({
		outcome: 'cancelled',
		run: { id: activeIds[0], status: 'cancelled' },
	})
	expect(
		runRecordMocks.listForUser('user-1').find((row) => row.id === activeIds[0]),
	).toMatchObject({ status: 'cancelled' })
})

test('RunLog terminal stickiness blocks later active regression after cancel', async () => {
	runRecordMocks.resetProjections()
	const binding = createStatefulWorkflowBinding()
	const env = {
		APP_DB: createWorkflowRunsDatabase(),
		DYNAMIC_CALLABLE_WORKFLOWS: binding.workflow,
		RUN_LOG: {} as DurableObjectNamespace,
	} as Env

	vi.useFakeTimers()
	try {
		vi.setSystemTime(new Date('2026-05-08T19:30:00.000Z'))
		const created = await createDynamicCallableWorkflow({
			env,
			userId: 'user-1',
			body: {
				code: 'export default async function main() { return { ok: true } }',
				idempotencyKey: 'terminal-sticky-key',
				runAt: '2026-05-08T19:30:00.000Z',
			},
		})

		vi.setSystemTime(new Date('2026-05-08T19:31:00.000Z'))
		await cancelWorkflowRunForUser({
			env,
			userId: 'user-1',
			workflowRunId: created.id,
		})
		const cancelled = runRecordMocks
			.listForUser('user-1')
			.find((row) => row.id === created.id)
		expect(cancelled).toMatchObject({
			status: 'cancelled',
			updatedAt: '2026-05-08T19:31:00.000Z',
		})
		if (!cancelled) throw new Error('Expected cancelled projection.')

		// A later queued write must not regress the terminal projection.
		await runRecordMocks.upsertWorkflowProjection({
			env,
			userId: 'user-1',
			projection: {
				...cancelled,
				status: 'queued',
				completedAt: null,
				updatedAt: '2026-05-08T19:32:00.000Z',
			},
		})
		expect(
			runRecordMocks.listForUser('user-1').find((row) => row.id === created.id),
		).toMatchObject({
			status: 'cancelled',
			updatedAt: '2026-05-08T19:31:00.000Z',
		})
	} finally {
		vi.useRealTimers()
	}
})

test('RunLog-only concurrent capacity blocks create without D1 workflow import', async () => {
	runRecordMocks.resetProjections()
	const binding = createStatefulWorkflowBinding()
	const env = {
		APP_DB: createWorkflowRunsDatabase(),
		DYNAMIC_CALLABLE_WORKFLOWS: binding.workflow,
		RUN_LOG: {} as DurableObjectNamespace,
	} as Env
	const freeLimit = planLimits.free.maxConcurrentWorkflows
	await seedActiveWorkflowProjections({
		userId: 'user-1',
		count: freeLimit,
	})
	runRecordMocks.upsertWorkflowProjection.mockClear()

	await expect(
		createDynamicCallableWorkflow({
			env,
			userId: 'user-1',
			body: {
				code: 'export default async function main() { return { ok: true } }',
				idempotencyKey: 'blocked-by-runlog-capacity',
				runAt: '2026-05-08T19:30:00.000Z',
			},
		}),
	).rejects.toSatisfy((error: unknown) => isEntitlementLimitError(error))
	expect(binding.create).not.toHaveBeenCalled()
	expect(
		runRecordMocks
			.listForUser('user-1')
			.filter((row) => row.status === 'queued'),
	).toHaveLength(freeLimit)
})

test('createDynamicCallableWorkflow enforces concurrent workflow entitlements across free, pro, and max plans', async () => {
	runRecordMocks.resetProjections()
	const freeLimit = planLimits.free.maxConcurrentWorkflows
	await seedActiveWorkflowProjections({
		userId: 'user-1',
		count: freeLimit - 1,
	})
	const concurrentBinding = createStatefulWorkflowBinding()
	const concurrentEnv = {
		APP_DB: createWorkflowRunsDatabase(),
		DYNAMIC_CALLABLE_WORKFLOWS: concurrentBinding.workflow,
		RUN_LOG: {} as DurableObjectNamespace,
	} as Env

	const results = await Promise.allSettled([
		createDynamicCallableWorkflow({
			env: concurrentEnv,
			userId: 'user-1',
			body: {
				code: 'export default async function main() { return { ok: true } }',
				idempotencyKey: 'concurrent-slot-a',
				runAt: '2026-05-08T19:30:00.000Z',
			},
		}),
		createDynamicCallableWorkflow({
			env: concurrentEnv,
			userId: 'user-1',
			body: {
				code: 'export default async function main() { return { ok: true } }',
				idempotencyKey: 'concurrent-slot-b',
				runAt: '2026-05-08T19:30:00.000Z',
			},
		}),
	])

	const fulfilled = results.filter((result) => result.status === 'fulfilled')
	const rejected = results.filter((result) => result.status === 'rejected')
	expect(fulfilled).toHaveLength(1)
	expect(rejected).toHaveLength(1)
	expect(isEntitlementLimitError(rejected[0]?.reason)).toBe(true)
	expect(concurrentBinding.create).toHaveBeenCalledTimes(1)
	expect(
		runRecordMocks
			.listForUser('user-1')
			.filter(
				(row) =>
					row.status != null &&
					(activeWorkflowStatusValues as ReadonlyArray<string>).includes(
						row.status,
					),
			),
	).toHaveLength(freeLimit)
	expect(
		runRecordMocks
			.listForUser('user-1')
			.filter((row) => row.status === creatingWorkflowProjectionStatus),
	).toHaveLength(0)

	runRecordMocks.resetProjections()
	await seedActiveWorkflowProjections({ userId: 'user-1', count: freeLimit })
	runRecordMocks.countActiveWorkflowProjections.mockClear()
	runRecordMocks.reserveWorkflowProjectionSlot.mockClear()
	runRecordMocks.deleteWorkflowProjectionIfCreating.mockClear()
	let error: unknown
	try {
		await createDynamicCallableWorkflow({
			env: {
				APP_DB: createWorkflowRunsDatabase(),
				DYNAMIC_CALLABLE_WORKFLOWS: createStatefulWorkflowBinding().workflow,
				RUN_LOG: {} as DurableObjectNamespace,
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
		`your "free" plan allows at most ${freeLimit} concurrent workflows`,
	)
	expect(error.details).toMatchObject({
		code: 'entitlement_limit_exceeded',
		resource: 'concurrent_workflows',
		plan: 'free',
		limit: freeLimit,
		current: freeLimit,
	})
	expect(runRecordMocks.reserveWorkflowProjectionSlot).toHaveBeenCalledWith(
		expect.objectContaining({ userId: 'user-1' }),
	)
	expect(runRecordMocks.deleteWorkflowProjectionIfCreating).toHaveBeenCalled()
	expect(activeWorkflowStatusValues).toContain('queued')

	const email = 'plan-user@example.com'
	const userId = await createStableUserIdFromEmail(email)
	const proLimit = planLimits.pro.maxConcurrentWorkflows
	if (proLimit == null) throw new Error('Expected pro plan workflow limit.')
	const proBinding = createStatefulWorkflowBinding()
	const body = {
		code: 'export default async function main() { return { ok: true } }',
		runAt: '2026-05-03T12:34:56.000Z',
		idempotencyKey: 'plan-limit-key',
	}
	runRecordMocks.resetProjections()
	await seedActiveWorkflowProjections({ userId, count: proLimit })
	runRecordMocks.reserveWorkflowProjectionSlot.mockClear()
	runRecordMocks.deleteWorkflowProjectionIfCreating.mockClear()
	let denied: unknown
	try {
		await createDynamicCallableWorkflow({
			env: {
				APP_DB: createWorkflowRunsDatabase({
					users: [{ email, plan: 'pro', stable_user_id: userId }],
				}),
				DYNAMIC_CALLABLE_WORKFLOWS: proBinding.workflow,
				RUN_LOG: {} as DurableObjectNamespace,
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
		plan: 'pro',
		limit: proLimit,
		current: proLimit,
	})
	expect(denied.message).toContain(`at most ${proLimit} concurrent workflows`)
	expect(runRecordMocks.reserveWorkflowProjectionSlot).toHaveBeenCalledWith(
		expect.objectContaining({ userId }),
	)
	expect(runRecordMocks.deleteWorkflowProjectionIfCreating).toHaveBeenCalled()

	runRecordMocks.resetProjections()
	await seedActiveWorkflowProjections({ userId, count: proLimit - 1 })
	const allowed = await createDynamicCallableWorkflow({
		env: {
			APP_DB: createWorkflowRunsDatabase({
				users: [{ email, plan: 'pro', stable_user_id: userId }],
			}),
			DYNAMIC_CALLABLE_WORKFLOWS: createStatefulWorkflowBinding().workflow,
			RUN_LOG: {} as DurableObjectNamespace,
		} as Env,
		userId,
		userEmail: email,
		body: {
			...body,
			idempotencyKey: 'plan-limit-allowed-key',
		},
	})
	expect(allowed.ok).toBe(true)

	// Background workflow callers carry the real account email, so a max-plan
	// account is not wrongly capped at the free concurrent limit.
	runRecordMocks.resetProjections()
	await seedActiveWorkflowProjections({ userId, count: freeLimit })
	const maxAllowed = await createDynamicCallableWorkflow({
		env: {
			APP_DB: createWorkflowRunsDatabase({
				users: [{ email, plan: 'max', stable_user_id: userId }],
			}),
			DYNAMIC_CALLABLE_WORKFLOWS: createStatefulWorkflowBinding().workflow,
			RUN_LOG: {} as DurableObjectNamespace,
		} as Env,
		userId,
		userEmail: email,
		body: {
			...body,
			idempotencyKey: 'plan-limit-blank-email-max-key',
		},
	})
	expect(maxAllowed.ok).toBe(true)
})

test('listWorkflowRunsForUser returns recent workflow statuses', async () => {
	runRecordMocks.resetProjections()
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

	runRecordMocks.upsertWorkflowProjection.mockClear()
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
	expect(runRecordMocks.upsertWorkflowProjection).not.toHaveBeenCalled()
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
	runRecordMocks.resetProjections()
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
	runRecordMocks.resetProjections()
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
	expect(
		runRecordMocks
			.listForUser('user-1')
			.find((row) => row.id === failedCreated.id),
	).toMatchObject({
		status: 'errored',
		lastError: 'workflow failed',
	})

	recordUsageSpy.mockRestore()
})

test('workflow_run usage is recorded once across replays and never on failed terminal status writes', async () => {
	runRecordMocks.resetProjections()
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

		// A successful execution whose authoritative RunLog terminal projection
		// write fails must not be recorded as usage (and is not recorded at all
		// until the terminal transition succeeds on a later replay).
		recordUsageSpy.mockClear()
		runRecordMocks.resetProjections()
		const statusFailureDb = createWorkflowRunsDatabase()
		const statusFailureEnv = {
			APP_DB: statusFailureDb,
			DYNAMIC_CALLABLE_WORKFLOWS: binding.workflow,
			APP_BASE_URL: 'https://app.example.com',
			RUN_LOG: {} as DurableObjectNamespace,
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
		runRecordMocks.upsertWorkflowProjection.mockImplementation(
			async (input: {
				env: Env
				userId: string
				projection: WorkflowProjectionUpsertInput
			}) => {
				if (input.projection.status === 'complete') {
					throw new Error('terminal status write failed')
				}
				const store =
					runRecordMocks.projectionsByUser.get(input.userId) ??
					new Map<string, WorkflowProjectionRecord>()
				runRecordMocks.projectionsByUser.set(input.userId, store)
				const existing = store.get(input.projection.id) ?? null
				if (!existing) {
					store.set(input.projection.id, {
						id: input.projection.id,
						bindingName: input.projection.bindingName,
						sourceType: input.projection.sourceType,
						packageId: input.projection.packageId ?? null,
						kodyId: input.projection.kodyId ?? null,
						sourceId: input.projection.sourceId ?? null,
						workflowName: input.projection.workflowName,
						exportName: input.projection.exportName ?? null,
						idempotencyKey: input.projection.idempotencyKey,
						runAt: input.projection.runAt,
						planDate: input.projection.planDate ?? null,
						status: input.projection.status ?? null,
						createdAt:
							input.projection.createdAt?.trim() || new Date().toISOString(),
						updatedAt:
							input.projection.updatedAt?.trim() || new Date().toISOString(),
						completedAt: input.projection.completedAt ?? null,
						lastError: input.projection.lastError ?? null,
					})
					return { ok: true as const }
				}
				store.set(input.projection.id, {
					...existing,
					status: input.projection.status ?? null,
					updatedAt:
						input.projection.updatedAt?.trim() || new Date().toISOString(),
					completedAt: input.projection.completedAt ?? existing.completedAt,
					lastError: input.projection.lastError ?? existing.lastError,
				})
				return { ok: true as const }
			},
		)
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
		runRecordMocks.upsertWorkflowProjection.mockRestore()
	} finally {
		recordUsageSpy.mockRestore()
	}
})
