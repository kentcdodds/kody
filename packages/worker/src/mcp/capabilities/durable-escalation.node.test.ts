import { beforeEach, expect, test, vi } from 'vitest'
import {
	alreadyDispatchedWorkflowStatusExclusion,
	buildCallerScopedIdempotencyKey,
	defaultDurableEscalationBudgetMs,
	runWithDurableEscalation,
} from './durable-escalation.ts'
import { terminalWorkflowStatusValues } from '#worker/package-runtime/workflow-statuses.ts'
import { creatingWorkflowProjectionStatus } from '#worker/run-records/workflow-projection.ts'
import type {
	WorkflowProjectionRecord,
	WorkflowProjectionUpsertInput,
} from '#worker/run-records/service.ts'

const mockModule = vi.hoisted(() => ({
	createDynamicCallableWorkflow: vi.fn(),
}))

const runRecordMocks = vi.hoisted(() => {
	const projectionsByUser = new Map<
		string,
		Map<string, WorkflowProjectionRecord>
	>()

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
			createdAt: input.createdAt?.trim() || now,
			updatedAt: input.updatedAt?.trim() || now,
			completedAt: input.completedAt ?? null,
			lastError: input.lastError ?? null,
		}
	}

	return {
		resetProjections() {
			projectionsByUser.clear()
		},
		seed(userId: string, projection: WorkflowProjectionUpsertInput) {
			userStore(userId).set(projection.id, toRecord(projection))
		},
		upsertWorkflowProjection: vi.fn(
			async (input: {
				env: Env
				userId: string
				projection: WorkflowProjectionUpsertInput
			}) => {
				userStore(input.userId).set(
					input.projection.id,
					toRecord(input.projection),
				)
				return { ok: true as const }
			},
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
		findWorkflowProjectionByBindingIdempotencyKey: vi.fn(
			async (input: {
				env: Env
				userId: string
				bindingName: string
				idempotencyKey: string
			}) => {
				const matches = [...userStore(input.userId).values()]
					.filter(
						(row) =>
							row.bindingName === input.bindingName &&
							row.idempotencyKey === input.idempotencyKey,
					)
					.sort((left, right) => left.createdAt.localeCompare(right.createdAt))
				return matches[0] ?? null
			},
		),
	}
})

vi.mock(
	'#worker/package-runtime/package-workflows.ts',
	async (importOriginal) => {
		const actual =
			await importOriginal<
				typeof import('#worker/package-runtime/package-workflows.ts')
			>()
		return {
			...actual,
			createDynamicCallableWorkflow: (...args: Array<unknown>) =>
				mockModule.createDynamicCallableWorkflow(...args),
		}
	},
)

vi.mock('#worker/run-records/service.ts', () => ({
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
	findWorkflowProjectionByBindingIdempotencyKey: (...args: Array<unknown>) =>
		runRecordMocks.findWorkflowProjectionByBindingIdempotencyKey(
			...(args as [
				{
					env: Env
					userId: string
					bindingName: string
					idempotencyKey: string
				},
			]),
		),
}))

const projectionBindingName = 'DYNAMIC_CALLABLE_WORKFLOWS'

beforeEach(() => {
	runRecordMocks.resetProjections()
	mockModule.createDynamicCallableWorkflow.mockReset()
	runRecordMocks.upsertWorkflowProjection.mockClear()
	runRecordMocks.findWorkflowProjectionByIdempotencyKey.mockClear()
	runRecordMocks.findWorkflowProjectionByBindingIdempotencyKey.mockClear()
})

const publishParts = [
	'package_publish_external_push',
	'owner-platform',
	'package-1',
	'commit-new',
] as const

function envStub() {
	return {
		// Falsy so dual-read skips D1 prepare on the stub env.
		APP_DB: undefined as unknown as D1Database,
		DYNAMIC_CALLABLE_WORKFLOWS: {} as Workflow,
		RUN_LOG: {} as DurableObjectNamespace,
	} as Env
}

test('runWithDurableEscalation returns the inline result when work finishes within budget', async () => {
	const run = vi.fn(async () => ({ status: 'published', commit: 'abc' }))
	const outcome = await runWithDurableEscalation({
		env: envStub(),
		userId: 'user-1',
		idempotencyParts: ['publish', 'pkg-1', 'commit-1'],
		workflowName: 'package_publish_external_push',
		durableCode: 'export default async function main() { return null }',
		budgetMs: 5_000,
		run,
	})

	expect(outcome).toEqual({
		kind: 'completed',
		value: { status: 'published', commit: 'abc' },
	})
	expect(run).toHaveBeenCalledTimes(1)
	expect(run.mock.calls[0]?.[0]).toBeInstanceOf(AbortSignal)
	expect(mockModule.createDynamicCallableWorkflow).not.toHaveBeenCalled()
	expect(defaultDurableEscalationBudgetMs).toBeLessThan(90_000)
})

test('runWithDurableEscalation dispatches once on budget exhaustion and reuses an active run for the same caller', async () => {
	mockModule.createDynamicCallableWorkflow.mockResolvedValue({
		ok: true,
		id: 'dynwf-escalated-1',
		workflow_name: 'package_publish_external_push',
		source_type: 'inline',
		run_at: '2026-07-27T00:00:00.000Z',
		plan_date: '2026-07-27',
		status: 'queued',
	})

	const hangUntilAborted = vi.fn(
		async (signal: AbortSignal) =>
			await new Promise<never>((_resolve, reject) => {
				signal.addEventListener(
					'abort',
					() => {
						reject(new DOMException('Aborted', 'AbortError'))
					},
					{ once: true },
				)
			}),
	)

	const expectedKey = buildCallerScopedIdempotencyKey({
		userId: 'user-1',
		parts: publishParts,
	})

	const first = await runWithDurableEscalation({
		env: envStub(),
		userId: 'user-1',
		userEmail: 'user@example.com',
		idempotencyParts: publishParts,
		workflowName: 'package_publish_external_push',
		durableCode:
			'import { kody } from "kody:runtime"; export default async function main(p) { return await kody.package_publish_external_push(p) }',
		durableParams: { package_id: 'pkg-1' },
		budgetMs: 30,
		run: hangUntilAborted,
	})

	expect(first).toEqual({
		kind: 'dispatched',
		handle: {
			status: 'dispatched',
			workflow_id: 'dynwf-escalated-1',
			workflow_name: 'package_publish_external_push',
			idempotency_key: expectedKey,
			run_status: 'queued',
			message: expect.stringMatching(/dispatched to a durable workflow/i),
		},
	})
	expect(mockModule.createDynamicCallableWorkflow).toHaveBeenCalledTimes(1)
	expect(mockModule.createDynamicCallableWorkflow).toHaveBeenCalledWith(
		expect.objectContaining({
			userId: 'user-1',
			userEmail: 'user@example.com',
			body: expect.objectContaining({
				idempotencyKey: expectedKey,
				workflowName: 'package_publish_external_push',
				params: { package_id: 'pkg-1' },
			}),
		}),
	)

	mockModule.createDynamicCallableWorkflow.mockClear()
	runRecordMocks.seed('user-1', {
		id: 'dynwf-escalated-1',
		bindingName: projectionBindingName,
		sourceType: 'inline',
		workflowName: 'package_publish_external_push',
		idempotencyKey: expectedKey,
		runAt: '2026-07-27T00:00:00.000Z',
		status: 'running',
	})

	const second = await runWithDurableEscalation({
		env: envStub(),
		userId: 'user-1',
		idempotencyParts: publishParts,
		workflowName: 'package_publish_external_push',
		durableCode: 'export default async function main() { return null }',
		budgetMs: 30,
		run: hangUntilAborted,
	})

	expect(second).toEqual({
		kind: 'dispatched',
		handle: expect.objectContaining({
			status: 'dispatched',
			workflow_id: 'dynwf-escalated-1',
			idempotency_key: expectedKey,
			run_status: 'running',
		}),
	})
	expect(mockModule.createDynamicCallableWorkflow).not.toHaveBeenCalled()
	expect(hangUntilAborted).toHaveBeenCalledTimes(1)
	expect(
		runRecordMocks.findWorkflowProjectionByIdempotencyKey,
	).toHaveBeenCalled()
})

test('mid-creation workflow projection rows are treated as already dispatched', async () => {
	expect(alreadyDispatchedWorkflowStatusExclusion).toEqual(
		terminalWorkflowStatusValues,
	)
	expect(alreadyDispatchedWorkflowStatusExclusion).not.toContain('creating')

	const hangUntilAborted = vi.fn(
		async (signal: AbortSignal) =>
			await new Promise<never>((_resolve, reject) => {
				signal.addEventListener(
					'abort',
					() => {
						reject(new DOMException('Aborted', 'AbortError'))
					},
					{ once: true },
				)
			}),
	)
	const expectedKey = buildCallerScopedIdempotencyKey({
		userId: 'user-1',
		parts: publishParts,
	})
	runRecordMocks.seed('user-1', {
		id: 'dynwf-creating-1',
		bindingName: projectionBindingName,
		sourceType: 'inline',
		workflowName: 'package_publish_external_push',
		idempotencyKey: expectedKey,
		runAt: '2026-07-27T00:00:00.000Z',
		status: creatingWorkflowProjectionStatus,
	})

	const outcome = await runWithDurableEscalation({
		env: envStub(),
		userId: 'user-1',
		idempotencyParts: publishParts,
		workflowName: 'package_publish_external_push',
		durableCode: 'export default async function main() { return null }',
		budgetMs: 30,
		run: hangUntilAborted,
	})

	expect(outcome).toEqual({
		kind: 'dispatched',
		handle: expect.objectContaining({
			status: 'dispatched',
			workflow_id: 'dynwf-creating-1',
			idempotency_key: expectedKey,
			run_status: 'creating',
		}),
	})
	expect(hangUntilAborted).not.toHaveBeenCalled()
	expect(mockModule.createDynamicCallableWorkflow).not.toHaveBeenCalled()
	expect(
		runRecordMocks.findWorkflowProjectionByBindingIdempotencyKey,
	).toHaveBeenCalledWith(
		expect.objectContaining({
			userId: 'user-1',
			bindingName: projectionBindingName,
			idempotencyKey: expectedKey,
		}),
	)
})

test('different acting callers get non-colliding dedupe; same caller still reuses', async () => {
	const hangUntilAborted = async (signal: AbortSignal) =>
		await new Promise<never>((_resolve, reject) => {
			signal.addEventListener(
				'abort',
				() => {
					reject(new DOMException('Aborted', 'AbortError'))
				},
				{ once: true },
			)
		})

	const delegateAKey = buildCallerScopedIdempotencyKey({
		userId: 'delegate-a',
		parts: publishParts,
	})
	const delegateBKey = buildCallerScopedIdempotencyKey({
		userId: 'delegate-b',
		parts: publishParts,
	})
	expect(delegateAKey).not.toBe(delegateBKey)
	expect(delegateAKey).toBe(
		'delegate-a:package_publish_external_push:owner-platform:package-1:commit-new',
	)
	expect(delegateBKey).toBe(
		'delegate-b:package_publish_external_push:owner-platform:package-1:commit-new',
	)

	mockModule.createDynamicCallableWorkflow
		.mockResolvedValueOnce({
			ok: true,
			id: 'dynwf-delegate-a',
			workflow_name: 'package_publish_external_push',
			source_type: 'inline',
			run_at: '2026-07-27T00:00:00.000Z',
			plan_date: '2026-07-27',
			status: 'queued',
		})
		.mockResolvedValueOnce({
			ok: true,
			id: 'dynwf-delegate-b',
			workflow_name: 'package_publish_external_push',
			source_type: 'inline',
			run_at: '2026-07-27T00:00:00.000Z',
			plan_date: '2026-07-27',
			status: 'queued',
		})

	const delegateA = await runWithDurableEscalation({
		env: envStub(),
		userId: 'delegate-a',
		idempotencyParts: publishParts,
		workflowName: 'package_publish_external_push',
		durableCode: 'export default async function main() { return null }',
		budgetMs: 30,
		run: hangUntilAborted,
	})
	expect(delegateA).toEqual({
		kind: 'dispatched',
		handle: expect.objectContaining({
			workflow_id: 'dynwf-delegate-a',
			idempotency_key: delegateAKey,
		}),
	})
	runRecordMocks.seed('delegate-a', {
		id: 'dynwf-delegate-a',
		bindingName: projectionBindingName,
		sourceType: 'inline',
		workflowName: 'package_publish_external_push',
		idempotencyKey: delegateAKey,
		runAt: '2026-07-27T00:00:00.000Z',
		status: 'running',
	})

	// A second acting caller must not reuse the first caller's active row even
	// when owner/package/commit parts match (projections are user-scoped).
	const delegateB = await runWithDurableEscalation({
		env: envStub(),
		userId: 'delegate-b',
		idempotencyParts: publishParts,
		workflowName: 'package_publish_external_push',
		durableCode: 'export default async function main() { return null }',
		budgetMs: 30,
		run: hangUntilAborted,
	})
	expect(delegateB).toEqual({
		kind: 'dispatched',
		handle: expect.objectContaining({
			workflow_id: 'dynwf-delegate-b',
			idempotency_key: delegateBKey,
		}),
	})
	expect(mockModule.createDynamicCallableWorkflow).toHaveBeenCalledTimes(2)
	expect(mockModule.createDynamicCallableWorkflow).toHaveBeenNthCalledWith(
		1,
		expect.objectContaining({
			userId: 'delegate-a',
			body: expect.objectContaining({ idempotencyKey: delegateAKey }),
		}),
	)
	expect(mockModule.createDynamicCallableWorkflow).toHaveBeenNthCalledWith(
		2,
		expect.objectContaining({
			userId: 'delegate-b',
			body: expect.objectContaining({ idempotencyKey: delegateBKey }),
		}),
	)

	mockModule.createDynamicCallableWorkflow.mockClear()
	runRecordMocks.seed('delegate-b', {
		id: 'dynwf-delegate-b',
		bindingName: projectionBindingName,
		sourceType: 'inline',
		workflowName: 'package_publish_external_push',
		idempotencyKey: delegateBKey,
		runAt: '2026-07-27T00:00:00.000Z',
		status: 'running',
	})

	const delegateARepeat = await runWithDurableEscalation({
		env: envStub(),
		userId: 'delegate-a',
		idempotencyParts: publishParts,
		workflowName: 'package_publish_external_push',
		durableCode: 'export default async function main() { return null }',
		budgetMs: 30,
		run: hangUntilAborted,
	})
	expect(delegateARepeat).toEqual({
		kind: 'dispatched',
		handle: expect.objectContaining({
			workflow_id: 'dynwf-delegate-a',
			idempotency_key: delegateAKey,
			run_status: 'running',
		}),
	})
	expect(mockModule.createDynamicCallableWorkflow).not.toHaveBeenCalled()
})

test('runWithDurableEscalation never throws and reports structured failures', async () => {
	const rejected = await runWithDurableEscalation({
		env: envStub(),
		userId: 'user-1',
		idempotencyParts: ['publish', 'pkg-1', 'fail'],
		workflowName: 'package_publish_external_push',
		durableCode: 'export default async function main() { return null }',
		budgetMs: 5_000,
		run: async () => {
			throw new Error('checks blew up')
		},
	})
	expect(rejected).toEqual({
		kind: 'failed',
		error: 'checks blew up',
	})

	const emptyParts = await runWithDurableEscalation({
		env: envStub(),
		userId: 'user-1',
		idempotencyParts: ['   ', ''],
		workflowName: 'package_publish_external_push',
		durableCode: 'export default async function main() { return null }',
		run: async () => ({ ok: true }),
	})
	expect(emptyParts).toEqual({
		kind: 'failed',
		error: 'Durable escalation requires at least one idempotency part.',
	})

	mockModule.createDynamicCallableWorkflow.mockRejectedValue(
		new Error('Missing DYNAMIC_CALLABLE_WORKFLOWS binding.'),
	)
	const dispatchFailed = await runWithDurableEscalation({
		env: envStub(),
		userId: 'user-1',
		idempotencyParts: ['publish', 'pkg-1', 'dispatch-fail'],
		workflowName: 'package_publish_external_push',
		durableCode: 'export default async function main() { return null }',
		budgetMs: 20,
		run: async (signal) =>
			await new Promise<never>((_resolve, reject) => {
				signal.addEventListener(
					'abort',
					() => reject(new DOMException('Aborted', 'AbortError')),
					{ once: true },
				)
			}),
	})
	expect(dispatchFailed).toEqual({
		kind: 'failed',
		error: 'Missing DYNAMIC_CALLABLE_WORKFLOWS binding.',
	})
})

test('budget exhaustion fails closed when create single-flights onto a dead terminal run', async () => {
	const hangUntilAborted = vi.fn(
		async (signal: AbortSignal) =>
			await new Promise<never>((_resolve, reject) => {
				signal.addEventListener(
					'abort',
					() => {
						reject(new DOMException('Aborted', 'AbortError'))
					},
					{ once: true },
				)
			}),
	)

	mockModule.createDynamicCallableWorkflow.mockResolvedValueOnce({
		ok: true,
		id: 'dynwf-cancelled-1',
		workflow_name: 'package_publish_external_push',
		source_type: 'inline',
		run_at: '2026-07-27T00:00:00.000Z',
		plan_date: '2026-07-27',
		status: 'cancelled',
	})
	const cancelledOutcome = await runWithDurableEscalation({
		env: envStub(),
		userId: 'user-1',
		idempotencyParts: publishParts,
		workflowName: 'package_publish_external_push',
		durableCode: 'export default async function main() { return null }',
		budgetMs: 30,
		run: hangUntilAborted,
	})
	expect(cancelledOutcome.kind).toBe('failed')
	if (cancelledOutcome.kind !== 'failed') {
		throw new Error('Expected cancelled single-flight to fail closed.')
	}
	expect(cancelledOutcome.error).toContain('dynwf-cancelled-1')
	expect(cancelledOutcome.error).toContain('cancelled')
	expect(cancelledOutcome.error).toContain('blocks re-dispatch')

	mockModule.createDynamicCallableWorkflow.mockResolvedValueOnce({
		ok: true,
		id: 'dynwf-complete-1',
		workflow_name: 'package_publish_external_push',
		source_type: 'inline',
		run_at: '2026-07-27T00:00:00.000Z',
		plan_date: '2026-07-27',
		status: 'complete',
	})
	const completeParts = [...publishParts, 'complete-replay'] as const
	const completeOutcome = await runWithDurableEscalation({
		env: envStub(),
		userId: 'user-1',
		idempotencyParts: completeParts,
		workflowName: 'package_publish_external_push',
		durableCode: 'export default async function main() { return null }',
		budgetMs: 30,
		run: hangUntilAborted,
	})
	expect(completeOutcome).toEqual({
		kind: 'dispatched',
		handle: expect.objectContaining({
			status: 'dispatched',
			workflow_id: 'dynwf-complete-1',
			run_status: 'complete',
			idempotency_key: buildCallerScopedIdempotencyKey({
				userId: 'user-1',
				parts: completeParts,
			}),
		}),
	})
})

test('budget abort dispatches while the inline attempt is still in flight', async () => {
	const events: Array<string> = []
	mockModule.createDynamicCallableWorkflow.mockImplementation(async () => {
		events.push('dispatched')
		return {
			ok: true,
			id: 'dynwf-overlap-1',
			workflow_name: 'package_publish_external_push',
			source_type: 'inline',
			run_at: '2026-07-27T00:00:00.000Z',
			plan_date: '2026-07-27',
			status: 'queued',
		}
	})

	let releaseInline: (() => void) | null = null
	const outcome = await runWithDurableEscalation({
		env: envStub(),
		userId: 'user-1',
		idempotencyParts: ['publish', 'pkg-1', 'overlap'],
		workflowName: 'package_publish_external_push',
		durableCode: 'export default async function main() { return null }',
		budgetMs: 30,
		run: async (signal) => {
			events.push('run-start')
			await new Promise<void>((resolve) => {
				signal.addEventListener(
					'abort',
					() => {
						events.push('aborted')
						resolve()
					},
					{ once: true },
				)
			})
			// Stay in flight after abort until the test releases us. The helper
			// must dispatch without awaiting this completion.
			await new Promise<void>((resolve) => {
				releaseInline = resolve
			})
			events.push('run-end')
			return { status: 'published' }
		},
	})

	expect(outcome.kind).toBe('dispatched')
	expect(events).toEqual(['run-start', 'aborted', 'dispatched'])
	expect(events).not.toContain('run-end')
	releaseInline?.()
})
