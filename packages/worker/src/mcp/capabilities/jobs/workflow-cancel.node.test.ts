import { expect, test, vi } from 'vitest'
import { createMcpCallerContext } from '#mcp/context.ts'

const mockModule = vi.hoisted(() => ({
	cancelWorkflowRunForUser: vi.fn(),
}))

vi.mock('#worker/package-runtime/package-workflows.ts', () => ({
	cancelWorkflowRunForUser: (...args: Array<unknown>) =>
		mockModule.cancelWorkflowRunForUser(...args),
}))

const { workflowCancelCapability } = await import('./workflow-cancel.ts')

test('workflow_run_cancel maps service outcomes for the signed-in user', async () => {
	const env = {} as Env
	const callerContext = createMcpCallerContext({
		baseUrl: 'https://example.com',
		user: {
			userId: 'user-123',
			email: 'user@example.com',
			displayName: 'User Example',
		},
	})

	mockModule.cancelWorkflowRunForUser.mockResolvedValueOnce({
		outcome: 'not_found',
	})
	await expect(
		workflowCancelCapability.handler(
			{ id: 'dynwf-missing' },
			{ env, callerContext },
		),
	).rejects.toThrow('was not found for the current user')
	expect(mockModule.cancelWorkflowRunForUser).toHaveBeenCalledWith({
		env,
		userId: 'user-123',
		workflowRunId: 'dynwf-missing',
	})

	mockModule.cancelWorkflowRunForUser.mockResolvedValueOnce({
		outcome: 'cancelled',
		run: {
			id: 'dynwf-123',
			userId: 'user-123',
			sourceType: 'inline',
			packageId: null,
			kodyId: null,
			sourceId: null,
			workflowName: 'inline-code',
			exportName: null,
			idempotencyKey: 'cancel-key',
			runAt: '2026-05-03T12:00:00.000Z',
			planDate: '2026-05-03',
			status: 'cancelled',
			createdAt: '2026-05-03T11:59:00.000Z',
			updatedAt: '2026-05-03T12:00:01.000Z',
			completedAt: '2026-05-03T12:00:01.000Z',
			lastError: null,
		},
	})
	const cancelled = await workflowCancelCapability.handler(
		{ id: 'dynwf-123' },
		{ env, callerContext },
	)
	expect(cancelled).toEqual({
		id: 'dynwf-123',
		cancelled: true,
		already_terminal: false,
		status: 'cancelled',
		message: 'Workflow run cancelled.',
	})

	mockModule.cancelWorkflowRunForUser.mockResolvedValueOnce({
		outcome: 'already_terminal',
		run: {
			id: 'dynwf-done',
			userId: 'user-123',
			sourceType: 'inline',
			packageId: null,
			kodyId: null,
			sourceId: null,
			workflowName: 'inline-code',
			exportName: null,
			idempotencyKey: 'done-key',
			runAt: '2026-05-03T12:00:00.000Z',
			planDate: '2026-05-03',
			status: 'complete',
			createdAt: '2026-05-03T11:59:00.000Z',
			updatedAt: '2026-05-03T12:00:01.000Z',
			completedAt: '2026-05-03T12:00:01.000Z',
			lastError: null,
		},
	})
	const alreadyTerminal = await workflowCancelCapability.handler(
		{ id: 'dynwf-done' },
		{ env, callerContext },
	)
	expect(alreadyTerminal).toMatchObject({
		id: 'dynwf-done',
		cancelled: false,
		already_terminal: true,
		status: 'complete',
	})
	expect(alreadyTerminal.message).toContain('complete')
})
