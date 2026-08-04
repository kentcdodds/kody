import { expect, test, vi } from 'vitest'
import { isEntitlementLimitError } from '#worker/entitlements/errors.ts'
import { planLimits } from '#worker/entitlements/plans.ts'
import {
	activeWorkflowStatusValues,
	terminalWorkflowStatusValues,
} from '#worker/package-runtime/workflow-statuses.ts'
import { creatingWorkflowProjectionStatus } from '#worker/run-records/workflow-projection.ts'
import {
	type WorkflowProjectionRecord,
	type WorkflowProjectionUpsertInput,
} from '#worker/run-records/service.ts'
import { readFileSync } from 'node:fs'
import { createStableUserIdFromEmail } from '#worker/user-id.ts'
import {
	DynamicCallableWorkflowBase,
	cancelWorkflowRunForUser,
	createDynamicCallableWorkflow,
	dynamicCallableWorkflowsBindingName,
	listWorkflowRunsForUser,
	workflowExecutorTimeoutMs,
} from './package-workflows.ts'

const invocationMocks = vi.hoisted(() => ({
	invokePackageExport: vi.fn(),
	runModuleWithRegistry: vi.fn(),
}))

const remoteConnectorMocks = vi.hoisted(() => ({
	listAttachedRemoteConnectorRefs: vi.fn(async () => []),
}))

const runRecordMocks = vi.hoisted(() => {
	const projectionsByUser = new Map<
		string,
		Map<string, WorkflowProjectionRecord>
	>()
	const activeStatuses = new Set<string>([
		'queued',
		'running',
		'paused',
		'waiting',
		'waitingForPause',
		'unknown',
	])
	const reservationStatuses = new Set<string>([...activeStatuses, 'creating'])

	function userStore(userId: string) {
		let store = projectionsByUser.get(userId)
		if (!store) {
			store = new Map()
			projectionsByUser.set(userId, store)
		}
		return store
	}

	function toRecord(
		input: WorkflowProjectionUpsertInput,
		existing?: WorkflowProjectionRecord | null,
	): WorkflowProjectionRecord {
		const now = new Date().toISOString()
		return {
			id: input.id,
			bindingName: input.bindingName,
			sourceType: input.sourceType,
			packageId: input.packageId ?? null,
			kodyId: input.kodyId ?? null,
			sourceId: input.sourceId ?? null,
			workflowName: input.workflowName,
			exportName: input.exportName ?? null,
			idempotencyKey: input.idempotencyKey,
			runAt: input.runAt,
			planDate: input.planDate ?? null,
			status: input.status ?? null,
			createdAt: input.createdAt?.trim() || existing?.createdAt || now,
			updatedAt: input.updatedAt?.trim() || now,
			completedAt:
				input.completedAt === undefined
					? (existing?.completedAt ?? null)
					: input.completedAt,
			lastError:
				input.lastError === undefined
					? (existing?.lastError ?? null)
					: input.lastError,
		}
	}

	function applyProjectionUpsert(
		userId: string,
		projection: WorkflowProjectionUpsertInput,
	) {
		const store = userStore(userId)
		const existing = store.get(projection.id) ?? null
		const nextUpdatedAt =
			projection.updatedAt?.trim() || new Date().toISOString()
		if (!existing) {
			store.set(projection.id, toRecord(projection, null))
			return
		}
		// Monotonic by updatedAt + terminal stickiness (matches RunLog DO).
		if (nextUpdatedAt < existing.updatedAt) {
			return
		}
		const nextStatus = projection.status ?? null
		if (
			existing.status != null &&
			(terminalWorkflowStatusValues as ReadonlyArray<string>).includes(
				existing.status,
			) &&
			(nextStatus == null ||
				!(terminalWorkflowStatusValues as ReadonlyArray<string>).includes(
					nextStatus,
				))
		) {
			return
		}
		store.set(projection.id, {
			...existing,
			status: nextStatus,
			updatedAt: nextUpdatedAt,
			completedAt: projection.completedAt ?? existing.completedAt ?? null,
			lastError: projection.lastError ?? existing.lastError ?? null,
		})
	}

	const upsertWorkflowProjection = vi.fn(
		async (input: {
			env: Env
			userId: string
			projection: WorkflowProjectionUpsertInput
		}) => {
			applyProjectionUpsert(input.userId, input.projection)
			return { ok: true as const }
		},
	)

	return {
		projectionsByUser,
		resetProjections() {
			projectionsByUser.clear()
		},
		listForUser(userId: string) {
			return [...(projectionsByUser.get(userId)?.values() ?? [])]
		},
		beginRunRecord: vi.fn(() => ({
			id: 'run-1',
			userId: 'user-1',
			startedAt: '2026-05-03T12:34:56.000Z',
			persistence: 'eager' as const,
			context: { surface: 'workflow' as const },
		})),
		finishRunRecord: vi.fn(async () => {}),
		upsertWorkflowProjection,
		getWorkflowProjection: vi.fn(
			async (input: { env: Env; userId: string; id: string }) =>
				userStore(input.userId).get(input.id) ?? null,
		),
		findWorkflowProjectionByIdempotencyKey: vi.fn(
			async (input: {
				env: Env
				userId: string
				idempotencyKey: string
				bindingName?: string | null
			}) => {
				const matches = [...userStore(input.userId).values()]
					.filter(
						(row) =>
							row.idempotencyKey === input.idempotencyKey &&
							row.status !== 'creating' &&
							(input.bindingName
								? row.bindingName === input.bindingName
								: true),
					)
					.sort((left, right) => left.createdAt.localeCompare(right.createdAt))
				return matches[0] ?? null
			},
		),
		listWorkflowProjections: vi.fn(
			async (input: {
				env: Env
				userId: string
				limit?: number | null
				cursor?: string | null
				status?: string | null
				bindingName?: string | null
			}) => {
				const limit = Math.min(Math.max(input.limit ?? 25, 1), 100)
				const rows = [...userStore(input.userId).values()]
					.filter(
						(row) =>
							(input.status ? row.status === input.status : true) &&
							(input.bindingName
								? row.bindingName === input.bindingName
								: true),
					)
					.sort((left, right) => right.createdAt.localeCompare(left.createdAt))
				return {
					projections: rows.slice(0, limit),
					nextCursor: null as string | null,
				}
			},
		),
		countActiveWorkflowProjections: vi.fn(
			async (input: { env: Env; userId: string }) =>
				[...userStore(input.userId).values()].filter(
					(row) => row.status != null && activeStatuses.has(row.status),
				).length,
		),
		reserveWorkflowProjectionSlot: vi.fn(
			async (input: {
				env: Env
				userId: string
				projection: WorkflowProjectionUpsertInput
			}) => {
				const store = userStore(input.userId)
				const existing = store.get(input.projection.id) ?? null
				const countBeforeReservation = [...store.values()].filter(
					(row) =>
						row.id !== input.projection.id &&
						row.status != null &&
						reservationStatuses.has(row.status),
				).length
				// Insert-only / creating-refresh: never clobber queued/running/terminal.
				if (
					existing?.status != null &&
					existing.status !== creatingWorkflowProjectionStatus
				) {
					return {
						countBeforeReservation,
						reserved: false,
						inserted: false,
						projection: existing,
					}
				}
				const now = new Date().toISOString()
				const inserted = existing == null
				// Keep count+insert synchronous (no await) so concurrent create
				// tests observe DO-like serialization under Promise.all.
				store.set(
					input.projection.id,
					toRecord(
						{
							...input.projection,
							status: 'creating',
							createdAt:
								input.projection.createdAt ?? existing?.createdAt ?? now,
							updatedAt: input.projection.updatedAt ?? now,
							completedAt: null,
							lastError: null,
						},
						existing,
					),
				)
				const projection = store.get(input.projection.id)
				if (!projection) {
					throw new Error('Expected reserved projection.')
				}
				return {
					countBeforeReservation,
					reserved: true,
					inserted,
					projection,
				}
			},
		),
		deleteWorkflowProjectionIfCreating: vi.fn(
			async (input: { env: Env; userId: string; id: string }) => {
				const store = userStore(input.userId)
				const existing = store.get(input.id)
				if (existing?.status === 'creating') {
					store.delete(input.id)
					return { deleted: true }
				}
				return { deleted: false }
			},
		),
	}
})

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

async function seedActiveWorkflowProjections(input: {
	userId: string
	count: number
}) {
	for (let index = 0; index < input.count; index += 1) {
		await runRecordMocks.upsertWorkflowProjection({
			env: {} as Env,
			userId: input.userId,
			projection: {
				id: `active-seed-${input.userId}-${index}`,
				bindingName: dynamicCallableWorkflowsBindingName,
				sourceType: 'inline',
				workflowName: `seed-${index}`,
				idempotencyKey: `seed-key-${input.userId}-${index}`,
				runAt: '2026-05-03T12:34:56.000Z',
				status: 'queued',
			},
		})
	}
}

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
			terminate: vi.fn(async () => {}),
		}
	})
	const get = vi.fn(async (id: string) => {
		if (!instances.has(id)) {
			throw new Error('workflow instance does not exist')
		}
		return {
			id,
			status: async () => ({ status: 'waiting' }),
			terminate: vi.fn(async () => {}),
		}
	})
	return {
		workflow: { get, create } as unknown as Workflow,
		get,
		create,
		instances,
	}
}

/** APP_DB stub for entitlement plan lookup and saved-package ownership only. */
function createWorkflowRunsDatabase(options?: {
	activeCount?: number
	savedPackage?: Record<string, unknown> | null
	users?: Array<{
		email: string
		plan: string | null
		stable_user_id?: string
	}>
}) {
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
			if (query.includes('workflow_runs')) {
				throw new Error(
					`Unexpected workflow_runs SQL after RunLog-only retirement: ${query}`,
				)
			}
			return {
				bind(...params: Array<unknown>) {
					return {
						async first() {
							if (query.includes('COUNT(*) AS count')) {
								return { count: options?.activeCount ?? 0 }
							}
							if (query.includes('SELECT plan, stripe_plan FROM users')) {
								if (query.includes('email = ?')) {
									const email = String(params[0] ?? '')
									const stableUserId = String(params[1] ?? '')
									const user = (options?.users ?? []).find(
										(row) =>
											row.email === email &&
											row.stable_user_id === stableUserId,
									)
									return user ? { plan: user.plan } : null
								}
								const stableUserId = String(params[0] ?? '')
								const user = (options?.users ?? []).find(
									(row) => row.stable_user_id === stableUserId,
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
							return null
						},
						async all() {
							return { results: [] }
						},
						async run() {
							// Entitlement/usage helpers may touch APP_DB; only
							// workflow_runs lifecycle SQL is retired.
							return { success: true }
						},
					}
				},
			}
		},
	}
	return db as unknown as D1Database
}

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
		{
			packageContext,
			executorTimeoutMs: workflowExecutorTimeoutMs,
		},
	)
})

test('DynamicCallableWorkflowBase restores attached remote connectors for inline code and package exports', async () => {
	runRecordMocks.resetProjections()
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
		{
			packageContext: null,
			executorTimeoutMs: workflowExecutorTimeoutMs,
		},
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
			ephemeral: true,
			executorTimeoutMs: workflowExecutorTimeoutMs,
			request: expect.objectContaining({
				idempotencyKey: null,
			}),
		}),
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
	expect(
		runRecordMocks.listForUser('user-1').find((row) => row.id === created.id),
	).toMatchObject({
		status: 'errored',
		completedAt: expect.any(String),
		lastError: expect.stringContaining(
			'kody.remote[\\"home\\"].bond_shade_set_position',
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

test('package workflow records failures before the inner invocation starts', async () => {
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
			idempotencyKey: 'package-pre-invocation-failure',
		},
	})
	const queued = binding.instances.get(created.id)
	if (!queued?.params) throw new Error('Expected queued workflow payload.')
	remoteConnectorMocks.listAttachedRemoteConnectorRefs.mockReset()
	remoteConnectorMocks.listAttachedRemoteConnectorRefs.mockResolvedValue([])
	invocationMocks.invokePackageExport.mockReset()
	remoteConnectorMocks.listAttachedRemoteConnectorRefs.mockRejectedValueOnce(
		new Error('remote connector lookup failed'),
	)
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
	).rejects.toThrow('remote connector lookup failed')
	expect(invocationMocks.invokePackageExport).not.toHaveBeenCalled()
	expect(runRecordMocks.beginRunRecord).toHaveBeenCalledTimes(1)
	expect(runRecordMocks.beginRunRecord).toHaveBeenCalledWith(
		expect.objectContaining({
			context: expect.objectContaining({
				surface: 'workflow',
				workflowId: created.id,
			}),
		}),
	)
	expect(runRecordMocks.finishRunRecord).toHaveBeenCalledWith(
		expect.objectContaining({
			status: 'error',
			error: expect.objectContaining({
				message: 'remote connector lookup failed',
			}),
		}),
	)
	expect(
		runRecordMocks.listForUser('user-1').find((row) => row.id === created.id),
	).toMatchObject({
		status: 'errored',
		lastError: 'remote connector lookup failed',
	})
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

test('package workflow lifecycle source has no workflow_runs SQL', () => {
	const source = readFileSync(
		new URL('./package-workflows.ts', import.meta.url),
		'utf8',
	)
	expect(source).not.toMatch(/\bworkflow_runs\b/)
	expect(source).not.toMatch(/\bimportWorkflowProjections\b/)
	expect(source).not.toMatch(/\breadD1WorkflowRun/)
	expect(source).not.toMatch(/\bmirrorWorkflowRunToD1\b/)
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

	// Package jobs persist email: '' — reverse-resolve by stable userId so a
	// max-plan account is not wrongly capped at the free concurrent limit.
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
		userEmail: '',
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
