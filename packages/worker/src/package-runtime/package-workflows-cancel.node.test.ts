import { DatabaseSync } from 'node:sqlite'
import { expect, test, vi } from 'vitest'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import {
	cancelWorkflowRunForUser,
	createDynamicCallableWorkflow,
	listWorkflowRunsForUser,
} from './package-workflows.ts'

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
	const env = {
		APP_DB: db,
		DYNAMIC_CALLABLE_WORKFLOWS: binding.workflow,
	} as Env

	const created = await createDynamicCallableWorkflow({
		env,
		userId: 'user-1',
		packageContext: null,
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
	const row = readWorkflowRunRow(sqlite, created.id)
	expect(row).toMatchObject({
		status: 'cancelled',
		completed_at: expect.any(String),
	})

	const listed = await listWorkflowRunsForUser({
		env,
		userId: 'user-1',
		limit: 10,
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
	const env = {
		APP_DB: db,
		DYNAMIC_CALLABLE_WORKFLOWS: binding.workflow,
	} as Env

	const created = await createDynamicCallableWorkflow({
		env,
		userId: 'user-1',
		packageContext: null,
		body: {
			code: 'export default async function main() { return { ok: true } }',
			idempotencyKey: 'isolation-key',
			runAt: '2026-05-03T12:34:56.000Z',
		},
	})
	const before = readWorkflowRunRow(sqlite, created.id)
	binding.get.mockClear()
	binding.create.mockClear()

	const result = await cancelWorkflowRunForUser({
		env,
		userId: 'user-2',
		workflowRunId: created.id,
	})
	expect(result).toEqual({ outcome: 'not_found' })
	expect(binding.terminateCalls).toEqual([])
	expect(binding.get).not.toHaveBeenCalled()
	expect(readWorkflowRunRow(sqlite, created.id)).toEqual(before)
	expect(before?.status).toBe('queued')
})

test('a cancelled run keeps single-flighting its idempotency key', async () => {
	const binding = createCancelTestBinding()
	const { db } = createWorkflowRunsDb()
	const env = {
		APP_DB: db,
		DYNAMIC_CALLABLE_WORKFLOWS: binding.workflow,
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
	const completeRaceBinding = createCancelTestBinding()
	const completeEnv = {
		APP_DB: db,
		DYNAMIC_CALLABLE_WORKFLOWS: completeRaceBinding.workflow,
	} as Env
	const completeCreated = await createDynamicCallableWorkflow({
		env: completeEnv,
		userId: 'user-1',
		packageContext: null,
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
	})
	expect(completeResult).toMatchObject({
		outcome: 'already_terminal',
		run: {
			id: completeCreated.id,
			status: 'complete',
			completedAt: expect.any(String),
		},
	})
	expect(readWorkflowRunRow(sqlite, completeCreated.id)).toMatchObject({
		status: 'complete',
		completed_at: expect.any(String),
	})

	const runningRaceSqlite = new DatabaseSync(':memory:')
	runningRaceSqlite.exec(workflowRunsDdl)
	const runningDb = createD1FromSqlite(runningRaceSqlite)
	const runningRaceBinding = createCancelTestBinding()
	const runningEnv = {
		APP_DB: runningDb,
		DYNAMIC_CALLABLE_WORKFLOWS: runningRaceBinding.workflow,
	} as Env
	const runningCreated = await createDynamicCallableWorkflow({
		env: runningEnv,
		userId: 'user-1',
		packageContext: null,
		body: {
			code: 'export default async function main() { return { ok: true } }',
			idempotencyKey: 'race-running-key',
			runAt: '2026-05-03T12:34:56.000Z',
		},
	})
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
		}),
	).rejects.toThrow('Instance is in a state that cannot be terminated')
	expect(
		readWorkflowRunRow(runningRaceSqlite, runningCreated.id),
	).toMatchObject({
		status: 'queued',
		completed_at: null,
	})
})

test('cancel projection loses to a concurrent complete write', async () => {
	const { sqlite, db } = createWorkflowRunsDb()
	const binding = createCancelTestBinding()
	const env = {
		APP_DB: db,
		DYNAMIC_CALLABLE_WORKFLOWS: binding.workflow,
	} as Env
	const created = await createDynamicCallableWorkflow({
		env,
		userId: 'user-1',
		packageContext: null,
		body: {
			code: 'export default async function main() { return { ok: true } }',
			idempotencyKey: 'guarded-projection-key',
			runAt: '2026-05-03T12:34:56.000Z',
		},
	})
	const completedAt = '2026-05-03T12:35:00.000Z'
	binding.perInstance.set(created.id, {
		onTerminate: async () => {
			await db
				.prepare(
					`UPDATE workflow_runs
					SET status = 'complete', completed_at = ?, updated_at = ?
					WHERE id = ? AND user_id = ?`,
				)
				.bind(completedAt, completedAt, created.id, 'user-1')
				.run()
		},
	})

	const result = await cancelWorkflowRunForUser({
		env,
		userId: 'user-1',
		workflowRunId: created.id,
	})
	expect(result).toMatchObject({
		outcome: 'already_terminal',
		run: {
			id: created.id,
			status: 'complete',
			completedAt,
		},
	})
	expect(readWorkflowRunRow(sqlite, created.id)).toMatchObject({
		status: 'complete',
		completed_at: completedAt,
	})
})

test('cancelling a run whose engine instance is missing still projects cancelled', async () => {
	const { sqlite, db } = createWorkflowRunsDb()
	const binding = createCancelTestBinding()
	const now = '2026-05-03T12:34:56.000Z'
	const runId = 'dynwf-missing-instance'
	await db
		.prepare(
			`INSERT INTO workflow_runs (
				id, user_id, source_type, package_id, kody_id, source_id,
				workflow_name, export_name, idempotency_key, run_at, plan_date,
				status, created_at, updated_at, completed_at, last_error
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		)
		.bind(
			runId,
			'user-1',
			'inline',
			null,
			null,
			null,
			'inline-code',
			null,
			'missing-instance-key',
			now,
			'2026-05-03',
			'queued',
			now,
			now,
			null,
			null,
		)
		.run()
	binding.missingIds.add(runId)

	const result = await cancelWorkflowRunForUser({
		env: {
			APP_DB: db,
			DYNAMIC_CALLABLE_WORKFLOWS: binding.workflow,
		} as Env,
		userId: 'user-1',
		workflowRunId: runId,
	})
	expect(result).toMatchObject({
		outcome: 'cancelled',
		run: { id: runId, status: 'cancelled' },
	})
	expect(binding.terminateCalls).toEqual([])
	expect(readWorkflowRunRow(sqlite, runId)).toMatchObject({
		status: 'cancelled',
		completed_at: expect.any(String),
	})
})
