import { expect, test, vi } from 'vitest'
import {
	defaultDurableEscalationBudgetMs,
	runWithDurableEscalation,
} from './durable-escalation.ts'
import { activeWorkflowStatusValues } from '#worker/package-runtime/workflow-statuses.ts'

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
							const statusFilter = new Set(
								params.slice(2).map((value) => String(value)),
							)
							return (
								rows.find(
									(row) =>
										row['user_id'] === userId &&
										row['idempotency_key'] === idempotencyKey &&
										statusFilter.has(String(row['status'] ?? '')),
								) ?? null
							)
						},
					}
				},
			}
		},
	} as unknown as D1Database
}

test('runWithDurableEscalation returns the inline result when work finishes within budget', async () => {
	const run = vi.fn(async () => ({ status: 'published', commit: 'abc' }))
	const outcome = await runWithDurableEscalation({
		env: {
			APP_DB: createWorkflowRunsDb(),
			DYNAMIC_CALLABLE_WORKFLOWS: {} as Workflow,
		} as Env,
		userId: 'user-1',
		idempotencyKey: 'publish:pkg-1:commit-1',
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

test('runWithDurableEscalation dispatches once on budget exhaustion and reuses an active run', async () => {
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

	const first = await runWithDurableEscalation({
		env: {
			APP_DB: createWorkflowRunsDb(),
			DYNAMIC_CALLABLE_WORKFLOWS: {} as Workflow,
		} as Env,
		userId: 'user-1',
		userEmail: 'user@example.com',
		idempotencyKey: 'publish:pkg-1:commit-slow',
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
			idempotency_key: 'publish:pkg-1:commit-slow',
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
				idempotencyKey: 'publish:pkg-1:commit-slow',
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
		idempotency_key: 'publish:pkg-1:commit-slow',
		status: 'running',
	}
	expect(activeWorkflowStatusValues).toContain('running')

	const second = await runWithDurableEscalation({
		env: {
			APP_DB: createWorkflowRunsDb([activeRow]),
			DYNAMIC_CALLABLE_WORKFLOWS: {} as Workflow,
		} as Env,
		userId: 'user-1',
		idempotencyKey: 'publish:pkg-1:commit-slow',
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
			idempotency_key: 'publish:pkg-1:commit-slow',
			run_status: 'running',
		}),
	})
	expect(mockModule.createDynamicCallableWorkflow).not.toHaveBeenCalled()
	expect(hangUntilAborted).toHaveBeenCalledTimes(1)
})

test('runWithDurableEscalation never throws and reports structured failures', async () => {
	const rejected = await runWithDurableEscalation({
		env: {
			APP_DB: createWorkflowRunsDb(),
			DYNAMIC_CALLABLE_WORKFLOWS: {} as Workflow,
		} as Env,
		userId: 'user-1',
		idempotencyKey: 'publish:pkg-1:fail',
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

	const emptyKey = await runWithDurableEscalation({
		env: {
			APP_DB: createWorkflowRunsDb(),
			DYNAMIC_CALLABLE_WORKFLOWS: {} as Workflow,
		} as Env,
		userId: 'user-1',
		idempotencyKey: '   ',
		workflowName: 'package_publish_external_push',
		durableCode: 'export default async function main() { return null }',
		run: async () => ({ ok: true }),
	})
	expect(emptyKey).toEqual({
		kind: 'failed',
		error: 'Durable escalation requires a non-empty idempotencyKey.',
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
		idempotencyKey: 'publish:pkg-1:dispatch-fail',
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
