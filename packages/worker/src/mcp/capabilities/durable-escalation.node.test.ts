import { expect, test, vi } from 'vitest'
import {
	alreadyDispatchedWorkflowStatusExclusion,
	buildCallerScopedIdempotencyKey,
	defaultDurableEscalationBudgetMs,
	runWithDurableEscalation,
} from './durable-escalation.ts'
import { terminalWorkflowStatusValues } from '#worker/package-runtime/workflow-statuses.ts'

const mockModule = vi.hoisted(() => ({
	createDynamicCallableWorkflow: vi.fn(),
}))

vi.mock('#worker/package-runtime/package-workflows.ts', () => ({
	createDynamicCallableWorkflow: (...args: Array<unknown>) =>
		mockModule.createDynamicCallableWorkflow(...args),
}))

function createWorkflowRunsDb(rows: Array<Record<string, unknown>> = []) {
	return {
		prepare(query: string) {
			return {
				bind(...params: Array<unknown>) {
					return {
						async first() {
							if (
								!query.includes('FROM workflow_runs') ||
								!query.includes('idempotency_key = ?')
							) {
								return null
							}
							const userId = params[0]
							const idempotencyKey = params[1]
							const excludedStatuses = new Set(
								params.slice(2).map((value) => String(value)),
							)
							const usesNotIn = query.includes('NOT IN')
							return (
								rows.find((row) => {
									if (
										row['user_id'] !== userId ||
										row['idempotency_key'] !== idempotencyKey
									) {
										return false
									}
									const status = String(row['status'] ?? '')
									return usesNotIn
										? !excludedStatuses.has(status)
										: excludedStatuses.has(status)
								}) ?? null
							)
						},
					}
				},
			}
		},
	} as unknown as D1Database
}

const publishParts = [
	'package_publish_external_push',
	'owner-platform',
	'package-1',
	'commit-new',
] as const

test('runWithDurableEscalation returns the inline result when work finishes within budget', async () => {
	const run = vi.fn(async () => ({ status: 'published', commit: 'abc' }))
	const outcome = await runWithDurableEscalation({
		env: {
			APP_DB: createWorkflowRunsDb(),
			DYNAMIC_CALLABLE_WORKFLOWS: {} as Workflow,
		} as Env,
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
		env: {
			APP_DB: createWorkflowRunsDb(),
			DYNAMIC_CALLABLE_WORKFLOWS: {} as Workflow,
		} as Env,
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
	const activeRow = {
		id: 'dynwf-escalated-1',
		user_id: 'user-1',
		workflow_name: 'package_publish_external_push',
		idempotency_key: expectedKey,
		status: 'running',
	}

	const second = await runWithDurableEscalation({
		env: {
			APP_DB: createWorkflowRunsDb([activeRow]),
			DYNAMIC_CALLABLE_WORKFLOWS: {} as Workflow,
		} as Env,
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
})

test('mid-creation workflow_runs rows are treated as already dispatched', async () => {
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
	const creatingRow = {
		id: 'dynwf-creating-1',
		user_id: 'user-1',
		workflow_name: 'package_publish_external_push',
		idempotency_key: expectedKey,
		status: 'creating',
	}

	const outcome = await runWithDurableEscalation({
		env: {
			APP_DB: createWorkflowRunsDb([creatingRow]),
			DYNAMIC_CALLABLE_WORKFLOWS: {} as Workflow,
		} as Env,
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

	const activeRows: Array<Record<string, unknown>> = []
	const sharedDb = createWorkflowRunsDb(activeRows)

	const delegateA = await runWithDurableEscalation({
		env: {
			APP_DB: sharedDb,
			DYNAMIC_CALLABLE_WORKFLOWS: {} as Workflow,
		} as Env,
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
	activeRows.push({
		id: 'dynwf-delegate-a',
		user_id: 'delegate-a',
		workflow_name: 'package_publish_external_push',
		idempotency_key: delegateAKey,
		status: 'running',
	})

	// A second acting caller must not reuse the first caller's active row even
	// when owner/package/commit parts match (workflow_runs are user-scoped).
	const delegateB = await runWithDurableEscalation({
		env: {
			APP_DB: sharedDb,
			DYNAMIC_CALLABLE_WORKFLOWS: {} as Workflow,
		} as Env,
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
	activeRows.push({
		id: 'dynwf-delegate-b',
		user_id: 'delegate-b',
		workflow_name: 'package_publish_external_push',
		idempotency_key: delegateBKey,
		status: 'running',
	})

	const delegateARepeat = await runWithDurableEscalation({
		env: {
			APP_DB: sharedDb,
			DYNAMIC_CALLABLE_WORKFLOWS: {} as Workflow,
		} as Env,
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
		env: {
			APP_DB: createWorkflowRunsDb(),
			DYNAMIC_CALLABLE_WORKFLOWS: {} as Workflow,
		} as Env,
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
		env: {
			APP_DB: createWorkflowRunsDb(),
			DYNAMIC_CALLABLE_WORKFLOWS: {} as Workflow,
		} as Env,
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
		env: {
			APP_DB: createWorkflowRunsDb(),
			DYNAMIC_CALLABLE_WORKFLOWS: {} as Workflow,
		} as Env,
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
		env: {
			APP_DB: createWorkflowRunsDb(),
			DYNAMIC_CALLABLE_WORKFLOWS: {} as Workflow,
		} as Env,
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
		env: {
			APP_DB: createWorkflowRunsDb(),
			DYNAMIC_CALLABLE_WORKFLOWS: {} as Workflow,
		} as Env,
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
		env: {
			APP_DB: createWorkflowRunsDb(),
			DYNAMIC_CALLABLE_WORKFLOWS: {} as Workflow,
		} as Env,
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
