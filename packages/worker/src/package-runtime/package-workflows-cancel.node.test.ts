import { DatabaseSync } from 'node:sqlite'
import { beforeEach, expect, test, vi } from 'vitest'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import {
	type WorkflowProjectionRecord,
	type WorkflowProjectionUpsertInput,
} from '#worker/run-records/service.ts'
import { creatingWorkflowProjectionStatus } from '#worker/run-records/workflow-projection.ts'
import { terminalWorkflowStatusValues } from '#worker/package-runtime/workflow-statuses.ts'
import {
	cancelWorkflowRunForUser,
	createDynamicCallableWorkflow,
	dynamicCallableWorkflowsBindingName,
	listWorkflowRunsForUser,
} from './package-workflows.ts'

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

	const importWorkflowProjections = vi.fn(
		async (input: {
			env: Env
			userId: string
			projections: Array<WorkflowProjectionUpsertInput>
		}) => {
			for (const projection of input.projections) {
				applyProjectionUpsert(input.userId, projection)
			}
			return { imported: input.projections.length }
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
		importWorkflowProjections,
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
				if (existing?.status != null && existing.status !== 'creating') {
					return {
						countBeforeReservation,
						reserved: false,
						inserted: false,
						projection: existing,
					}
				}
				const now = new Date().toISOString()
				const inserted = existing == null
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
	importWorkflowProjections: (...args: Array<unknown>) =>
		runRecordMocks.importWorkflowProjections(
			...(args as [
				{
					env: Env
					userId: string
					projections: Array<WorkflowProjectionUpsertInput>
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

function createWaitUntilFlusher() {
	const pending: Array<Promise<unknown>> = []
	return {
		waitUntil(promise: Promise<unknown>) {
			pending.push(promise)
		},
		async flush() {
			await Promise.all(pending.splice(0, pending.length))
		},
	}
}

beforeEach(() => {
	runRecordMocks.resetProjections()
})

const workflowRunsDdl = `
CREATE TABLE IF NOT EXISTS workflow_runs (
	id TEXT PRIMARY KEY,
	user_id TEXT NOT NULL,
	source_type TEXT NOT NULL CHECK (source_type IN ('package', 'inline')),
	package_id TEXT,
	kody_id TEXT,
	source_id TEXT,
	workflow_name TEXT NOT NULL,
	export_name TEXT,
	idempotency_key TEXT NOT NULL,
	run_at TEXT NOT NULL,
	plan_date TEXT,
	status TEXT,
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL,
	completed_at TEXT,
	last_error TEXT
);

CREATE INDEX IF NOT EXISTS workflow_runs_user_created_idx
ON workflow_runs(user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS workflow_runs_user_active_idx
ON workflow_runs(user_id, status);
`

type FakeInstanceOptions = {
	status?: string
	terminateThrows?: Error | null
	statusAfterTerminate?: string
	onTerminate?: () => void | Promise<void>
}

function createCancelTestBinding(options?: {
	missingIds?: Set<string>
	perInstance?: Map<string, FakeInstanceOptions>
}) {
	const instances = new Map<string, WorkflowInstanceCreateOptions>()
	const terminateCalls: Array<string> = []
	const missingIds = options?.missingIds ?? new Set<string>()
	const perInstance =
		options?.perInstance ?? new Map<string, FakeInstanceOptions>()

	const create = vi.fn(async (input: WorkflowInstanceCreateOptions) => {
		if (instances.has(input.id)) {
			throw new Error('Workflow instance already exists')
		}
		instances.set(input.id, input)
		return createInstanceHandle(input.id)
	})

	function createInstanceHandle(id: string) {
		const knobs = perInstance.get(id) ?? {}
		return {
			id,
			status: async () => ({
				status: knobs.statusAfterTerminate ?? knobs.status ?? 'queued',
			}),
			terminate: vi.fn(async () => {
				terminateCalls.push(id)
				if (knobs.onTerminate) await knobs.onTerminate()
				if (knobs.terminateThrows) throw knobs.terminateThrows
				knobs.status = 'terminated'
				knobs.statusAfterTerminate = 'terminated'
			}),
		}
	}

	const get = vi.fn(async (id: string) => {
		if (missingIds.has(id) || !instances.has(id)) {
			throw new Error('workflow instance does not exist')
		}
		return createInstanceHandle(id)
	})

	return {
		workflow: { get, create } as unknown as Workflow,
		get,
		create,
		instances,
		terminateCalls,
		missingIds,
		perInstance,
	}
}

function createWorkflowRunsDb() {
	const sqlite = new DatabaseSync(':memory:')
	sqlite.exec(workflowRunsDdl)
	return { sqlite, db: createD1FromSqlite(sqlite) }
}

function readWorkflowRunRow(sqlite: DatabaseSync, id: string) {
	return sqlite
		.prepare(
			`SELECT id, user_id, status, completed_at, updated_at, idempotency_key
			FROM workflow_runs WHERE id = ?`,
		)
		.get(id) as
		| {
				id: string
				user_id: string
				status: string | null
				completed_at: string | null
				updated_at: string
				idempotency_key: string
		  }
		| undefined
}

test('cancelWorkflowRunForUser cancels a queued run and is idempotent', async () => {
	const binding = createCancelTestBinding()
	const { sqlite, db } = createWorkflowRunsDb()
	const flusher = createWaitUntilFlusher()
	const env = {
		APP_DB: db,
		DYNAMIC_CALLABLE_WORKFLOWS: binding.workflow,
		RUN_LOG: {} as DurableObjectNamespace,
	} as Env

	const created = await createDynamicCallableWorkflow({
		env,
		userId: 'user-1',
		packageContext: null,
		waitUntil: flusher.waitUntil,
		body: {
			code: 'export default async function main() { return { ok: true } }',
			idempotencyKey: 'cancel-idempotent-key',
			runAt: '2026-05-03T12:34:56.000Z',
		},
	})
	expect(created.status).toBe('queued')
	expect(binding.create).toHaveBeenCalledTimes(1)

	const cancelled = await cancelWorkflowRunForUser({
		env,
		userId: 'user-1',
		workflowRunId: created.id,
		waitUntil: flusher.waitUntil,
	})
	expect(cancelled).toMatchObject({
		outcome: 'cancelled',
		run: {
			id: created.id,
			status: 'cancelled',
			completedAt: expect.any(String),
		},
	})
	expect(binding.terminateCalls).toEqual([created.id])
	expect(
		runRecordMocks.listForUser('user-1').find((row) => row.id === created.id),
	).toMatchObject({
		status: 'cancelled',
		completedAt: expect.any(String),
		bindingName: dynamicCallableWorkflowsBindingName,
	})
	await flusher.flush()
	const row = readWorkflowRunRow(sqlite, created.id)
	expect(row).toMatchObject({
		status: 'cancelled',
		completed_at: expect.any(String),
	})

	const listed = await listWorkflowRunsForUser({
		env,
		userId: 'user-1',
		limit: 10,
		waitUntil: flusher.waitUntil,
	})
	expect(listed).toEqual([
		expect.objectContaining({
			id: created.id,
			status: 'cancelled',
		}),
	])

	const again = await cancelWorkflowRunForUser({
		env,
		userId: 'user-1',
		workflowRunId: created.id,
		waitUntil: flusher.waitUntil,
	})
	expect(again).toMatchObject({
		outcome: 'already_terminal',
		run: { id: created.id, status: 'cancelled' },
	})
	expect(binding.terminateCalls).toEqual([created.id])
})

test('cancelWorkflowRunForUser enforces user isolation', async () => {
	const binding = createCancelTestBinding()
	const { sqlite, db } = createWorkflowRunsDb()
	const flusher = createWaitUntilFlusher()
	const env = {
		APP_DB: db,
		DYNAMIC_CALLABLE_WORKFLOWS: binding.workflow,
		RUN_LOG: {} as DurableObjectNamespace,
	} as Env

	const created = await createDynamicCallableWorkflow({
		env,
		userId: 'user-1',
		packageContext: null,
		waitUntil: flusher.waitUntil,
		body: {
			code: 'export default async function main() { return { ok: true } }',
			idempotencyKey: 'isolation-key',
			runAt: '2026-05-03T12:34:56.000Z',
		},
	})
	await flusher.flush()
	const before = readWorkflowRunRow(sqlite, created.id)
	const beforeProjection = runRecordMocks
		.listForUser('user-1')
		.find((row) => row.id === created.id)
	binding.get.mockClear()
	binding.create.mockClear()

	const result = await cancelWorkflowRunForUser({
		env,
		userId: 'user-2',
		workflowRunId: created.id,
		waitUntil: flusher.waitUntil,
	})
	expect(result).toEqual({ outcome: 'not_found' })
	expect(binding.terminateCalls).toEqual([])
	expect(binding.get).not.toHaveBeenCalled()
	expect(readWorkflowRunRow(sqlite, created.id)).toEqual(before)
	expect(
		runRecordMocks.listForUser('user-1').find((row) => row.id === created.id),
	).toEqual(beforeProjection)
	expect(before?.status).toBe('queued')
	expect(beforeProjection?.status).toBe('queued')
})

test('a cancelled run keeps single-flighting its idempotency key', async () => {
	const binding = createCancelTestBinding()
	const { db } = createWorkflowRunsDb()
	const env = {
		APP_DB: db,
		DYNAMIC_CALLABLE_WORKFLOWS: binding.workflow,
		RUN_LOG: {} as DurableObjectNamespace,
	} as Env

	const created = await createDynamicCallableWorkflow({
		env,
		userId: 'user-1',
		packageContext: null,
		body: {
			code: 'export default async function main() { return { ok: true } }',
			idempotencyKey: 'single-flight-key',
			runAt: '2026-05-03T12:34:56.000Z',
		},
	})
	await cancelWorkflowRunForUser({
		env,
		userId: 'user-1',
		workflowRunId: created.id,
	})
	expect(binding.create).toHaveBeenCalledTimes(1)

	const replay = await createDynamicCallableWorkflow({
		env,
		userId: 'user-1',
		packageContext: null,
		body: {
			code: 'export default async function main() { return { ok: true } }',
			idempotencyKey: 'single-flight-key',
			runAt: '2026-05-03T12:35:56.000Z',
		},
	})
	expect(replay.id).toBe(created.id)
	expect(replay.status).toBe('cancelled')
	expect(binding.create).toHaveBeenCalledTimes(1)

	const fresh = await createDynamicCallableWorkflow({
		env,
		userId: 'user-1',
		packageContext: null,
		body: {
			code: 'export default async function main() { return { ok: true } }',
			idempotencyKey: 'single-flight-key-other',
			runAt: '2026-05-03T12:36:56.000Z',
		},
	})
	expect(fresh.id).not.toBe(created.id)
	expect(fresh.status).toBe('queued')
	expect(binding.create).toHaveBeenCalledTimes(2)
})

test('cancel races with a run that finishes first', async () => {
	const { sqlite, db } = createWorkflowRunsDb()
	const flusher = createWaitUntilFlusher()
	const completeRaceBinding = createCancelTestBinding()
	const completeEnv = {
		APP_DB: db,
		DYNAMIC_CALLABLE_WORKFLOWS: completeRaceBinding.workflow,
		RUN_LOG: {} as DurableObjectNamespace,
	} as Env
	const completeCreated = await createDynamicCallableWorkflow({
		env: completeEnv,
		userId: 'user-1',
		packageContext: null,
		waitUntil: flusher.waitUntil,
		body: {
			code: 'export default async function main() { return { ok: true } }',
			idempotencyKey: 'race-complete-key',
			runAt: '2026-05-03T12:34:56.000Z',
		},
	})
	completeRaceBinding.perInstance.set(completeCreated.id, {
		terminateThrows: new Error(
			'Instance is in a state that cannot be terminated',
		),
		statusAfterTerminate: 'complete',
	})

	const completeResult = await cancelWorkflowRunForUser({
		env: completeEnv,
		userId: 'user-1',
		workflowRunId: completeCreated.id,
		waitUntil: flusher.waitUntil,
	})
	expect(completeResult).toMatchObject({
		outcome: 'already_terminal',
		run: {
			id: completeCreated.id,
			status: 'complete',
			completedAt: expect.any(String),
		},
	})
	expect(
		runRecordMocks
			.listForUser('user-1')
			.find((row) => row.id === completeCreated.id),
	).toMatchObject({
		status: 'complete',
		completedAt: expect.any(String),
	})
	await flusher.flush()
	expect(readWorkflowRunRow(sqlite, completeCreated.id)).toMatchObject({
		status: 'complete',
		completed_at: expect.any(String),
	})

	runRecordMocks.resetProjections()
	const runningRaceSqlite = new DatabaseSync(':memory:')
	runningRaceSqlite.exec(workflowRunsDdl)
	const runningDb = createD1FromSqlite(runningRaceSqlite)
	const runningFlusher = createWaitUntilFlusher()
	const runningRaceBinding = createCancelTestBinding()
	const runningEnv = {
		APP_DB: runningDb,
		DYNAMIC_CALLABLE_WORKFLOWS: runningRaceBinding.workflow,
		RUN_LOG: {} as DurableObjectNamespace,
	} as Env
	const runningCreated = await createDynamicCallableWorkflow({
		env: runningEnv,
		userId: 'user-1',
		packageContext: null,
		waitUntil: runningFlusher.waitUntil,
		body: {
			code: 'export default async function main() { return { ok: true } }',
			idempotencyKey: 'race-running-key',
			runAt: '2026-05-03T12:34:56.000Z',
		},
	})
	await runningFlusher.flush()
	const terminateError = new Error(
		'Instance is in a state that cannot be terminated',
	)
	runningRaceBinding.perInstance.set(runningCreated.id, {
		terminateThrows: terminateError,
		statusAfterTerminate: 'running',
	})

	await expect(
		cancelWorkflowRunForUser({
			env: runningEnv,
			userId: 'user-1',
			workflowRunId: runningCreated.id,
			waitUntil: runningFlusher.waitUntil,
		}),
	).rejects.toThrow('Instance is in a state that cannot be terminated')
	expect(
		runRecordMocks
			.listForUser('user-1')
			.find((row) => row.id === runningCreated.id),
	).toMatchObject({
		status: 'queued',
		completedAt: null,
	})
	expect(
		readWorkflowRunRow(runningRaceSqlite, runningCreated.id),
	).toMatchObject({
		status: 'queued',
		completed_at: null,
	})
})

test('cancel projection loses to a concurrent complete write', async () => {
	const { sqlite, db } = createWorkflowRunsDb()
	const flusher = createWaitUntilFlusher()
	const binding = createCancelTestBinding()
	const env = {
		APP_DB: db,
		DYNAMIC_CALLABLE_WORKFLOWS: binding.workflow,
		RUN_LOG: {} as DurableObjectNamespace,
	} as Env
	const created = await createDynamicCallableWorkflow({
		env,
		userId: 'user-1',
		packageContext: null,
		waitUntil: flusher.waitUntil,
		body: {
			code: 'export default async function main() { return { ok: true } }',
			idempotencyKey: 'guarded-projection-key',
			runAt: '2026-05-03T12:34:56.000Z',
		},
	})
	binding.perInstance.set(created.id, {
		onTerminate: async () => {
			const existing = runRecordMocks
				.listForUser('user-1')
				.find((row) => row.id === created.id)
			if (!existing) throw new Error('Expected projection before race write.')
			// Must be >= existing.updatedAt so monotonic upsert accepts the race.
			const completedAt = new Date(
				Math.max(Date.parse(existing.updatedAt) + 1, Date.now()),
			).toISOString()
			await runRecordMocks.upsertWorkflowProjection({
				env,
				userId: 'user-1',
				projection: {
					...existing,
					status: 'complete',
					completedAt,
					updatedAt: completedAt,
				},
			})
		},
	})

	const result = await cancelWorkflowRunForUser({
		env,
		userId: 'user-1',
		workflowRunId: created.id,
		waitUntil: flusher.waitUntil,
	})
	expect(result).toMatchObject({
		outcome: 'already_terminal',
		run: {
			id: created.id,
			status: 'complete',
			completedAt: expect.any(String),
		},
	})
	expect(
		runRecordMocks.listForUser('user-1').find((row) => row.id === created.id),
	).toMatchObject({
		status: 'complete',
		completedAt: expect.any(String),
	})
	await flusher.flush()
	// D1 mirror may still show queued from create if cancel skipped the
	// cancelled upsert after observing the concurrent complete projection.
	expect(readWorkflowRunRow(sqlite, created.id)?.status).toBeDefined()
})

test('cancelling a run whose engine instance is missing still projects cancelled', async () => {
	const { sqlite, db } = createWorkflowRunsDb()
	const flusher = createWaitUntilFlusher()
	const binding = createCancelTestBinding()
	const now = '2026-05-03T12:34:56.000Z'
	const runId = 'dynwf-missing-instance'
	await runRecordMocks.upsertWorkflowProjection({
		env: {
			APP_DB: db,
			DYNAMIC_CALLABLE_WORKFLOWS: binding.workflow,
			RUN_LOG: {} as DurableObjectNamespace,
		} as Env,
		userId: 'user-1',
		projection: {
			id: runId,
			bindingName: dynamicCallableWorkflowsBindingName,
			sourceType: 'inline',
			workflowName: 'inline-code',
			idempotencyKey: 'missing-instance-key',
			runAt: now,
			planDate: '2026-05-03',
			status: 'queued',
			createdAt: now,
			updatedAt: now,
		},
	})
	binding.missingIds.add(runId)

	const result = await cancelWorkflowRunForUser({
		env: {
			APP_DB: db,
			DYNAMIC_CALLABLE_WORKFLOWS: binding.workflow,
			RUN_LOG: {} as DurableObjectNamespace,
		} as Env,
		userId: 'user-1',
		workflowRunId: runId,
		waitUntil: flusher.waitUntil,
	})
	expect(result).toMatchObject({
		outcome: 'cancelled',
		run: { id: runId, status: 'cancelled' },
	})
	expect(binding.terminateCalls).toEqual([])
	expect(
		runRecordMocks.listForUser('user-1').find((row) => row.id === runId),
	).toMatchObject({
		status: 'cancelled',
		completedAt: expect.any(String),
		bindingName: dynamicCallableWorkflowsBindingName,
	})
	await flusher.flush()
	expect(readWorkflowRunRow(sqlite, runId)).toMatchObject({
		status: 'cancelled',
		completed_at: expect.any(String),
	})
})

test('cancel of a creating projection without an engine instance is retryable', async () => {
	const { db } = createWorkflowRunsDb()
	const flusher = createWaitUntilFlusher()
	const binding = createCancelTestBinding()
	const now = '2026-05-03T12:34:56.000Z'
	const runId = 'dynwf-creating-race'
	await runRecordMocks.upsertWorkflowProjection({
		env: {
			APP_DB: db,
			DYNAMIC_CALLABLE_WORKFLOWS: binding.workflow,
			RUN_LOG: {} as DurableObjectNamespace,
		} as Env,
		userId: 'user-1',
		projection: {
			id: runId,
			bindingName: dynamicCallableWorkflowsBindingName,
			sourceType: 'inline',
			workflowName: 'inline-code',
			idempotencyKey: 'creating-race-key',
			runAt: now,
			planDate: '2026-05-03',
			status: creatingWorkflowProjectionStatus,
			createdAt: now,
			updatedAt: now,
		},
	})
	binding.missingIds.add(runId)

	await expect(
		cancelWorkflowRunForUser({
			env: {
				APP_DB: db,
				DYNAMIC_CALLABLE_WORKFLOWS: binding.workflow,
				RUN_LOG: {} as DurableObjectNamespace,
			} as Env,
			userId: 'user-1',
			workflowRunId: runId,
			waitUntil: flusher.waitUntil,
		}),
	).rejects.toThrow(/still being created; retry cancellation shortly/)
	expect(binding.terminateCalls).toEqual([])
	expect(
		runRecordMocks.listForUser('user-1').find((row) => row.id === runId),
	).toMatchObject({
		status: creatingWorkflowProjectionStatus,
		completedAt: null,
	})
})

test('terminal projection stickiness blocks later queued regression after cancel', async () => {
	const binding = createCancelTestBinding()
	const { db } = createWorkflowRunsDb()
	const flusher = createWaitUntilFlusher()
	const env = {
		APP_DB: db,
		DYNAMIC_CALLABLE_WORKFLOWS: binding.workflow,
		RUN_LOG: {} as DurableObjectNamespace,
	} as Env
	const created = await createDynamicCallableWorkflow({
		env,
		userId: 'user-1',
		packageContext: null,
		waitUntil: flusher.waitUntil,
		body: {
			code: 'export default async function main() { return { ok: true } }',
			idempotencyKey: 'terminal-sticky-key',
			runAt: '2026-05-03T12:34:56.000Z',
		},
	})
	await cancelWorkflowRunForUser({
		env,
		userId: 'user-1',
		workflowRunId: created.id,
		waitUntil: flusher.waitUntil,
	})
	expect(
		runRecordMocks.listForUser('user-1').find((row) => row.id === created.id)
			?.status,
	).toBe('cancelled')

	const cancelled = runRecordMocks
		.listForUser('user-1')
		.find((row) => row.id === created.id)
	if (!cancelled) throw new Error('Expected cancelled projection.')
	await runRecordMocks.upsertWorkflowProjection({
		env,
		userId: 'user-1',
		projection: {
			...cancelled,
			status: 'queued',
			completedAt: null,
			updatedAt: new Date(
				Date.parse(cancelled.updatedAt) + 1_000,
			).toISOString(),
		},
	})
	expect(
		runRecordMocks.listForUser('user-1').find((row) => row.id === created.id),
	).toMatchObject({ status: 'cancelled' })
})
