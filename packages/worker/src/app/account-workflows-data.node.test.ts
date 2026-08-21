import { expect, test, vi } from 'vitest'
import {
	isActiveWorkflowStatus,
	isTerminalWorkflowStatus,
	loadAccountWorkflowsData,
	readAccountWorkflowsSelectedWorkflowId,
} from '#app/account-workflows-data.ts'
import { type WorkflowRunInspection } from '#worker/package-runtime/package-workflows.ts'

const mockModule = vi.hoisted(() => ({
	listWorkflowRunsForUser: vi.fn(),
	getWorkflowProjection: vi.fn(),
}))

vi.mock('#worker/package-runtime/package-workflows.ts', () => ({
	listWorkflowRunsForUser: (...args: Array<unknown>) =>
		mockModule.listWorkflowRunsForUser(...args),
}))

vi.mock('#worker/run-records/service.ts', () => ({
	getWorkflowProjection: (...args: Array<unknown>) =>
		mockModule.getWorkflowProjection(...args),
}))

const user = {
	sessionUserId: '42',
	userId: 42,
	username: 'test-user',
	email: 'user@example.com',
	displayName: 'user',
	artifactOwnerIds: [],
	mcpUser: {
		userId: 'stable-user-1',
		email: 'user@example.com',
		username: 'test-user',
		displayName: 'user',
	},
}

function makeWorkflow(
	overrides: Partial<WorkflowRunInspection> = {},
): WorkflowRunInspection {
	return {
		id: 'dynwf-1',
		userId: 'stable-user-1',
		bindingName: 'DYNAMIC_CALLABLE_WORKFLOWS',
		sourceType: 'inline',
		packageId: null,
		kodyId: null,
		sourceId: null,
		workflowName: 'Deferred digest',
		exportName: null,
		idempotencyKey: 'idem-1',
		runAt: '2026-07-28T12:00:00.000Z',
		planDate: '2026-07-28',
		status: 'queued',
		createdAt: '2026-07-27T12:00:00.000Z',
		updatedAt: '2026-07-27T12:00:00.000Z',
		completedAt: null,
		lastError: null,
		...overrides,
	}
}

test('workflow helpers parse selected ids and active/terminal status', () => {
	expect(isActiveWorkflowStatus('queued')).toBe(true)
	expect(isActiveWorkflowStatus('running')).toBe(true)
	expect(isActiveWorkflowStatus(null)).toBe(true)
	expect(isActiveWorkflowStatus('complete')).toBe(false)
	expect(isTerminalWorkflowStatus('cancelled')).toBe(true)
	expect(isTerminalWorkflowStatus('queued')).toBe(false)

	expect(
		readAccountWorkflowsSelectedWorkflowId(
			'https://example.com/account/workflows',
		),
	).toBeNull()
	expect(
		readAccountWorkflowsSelectedWorkflowId(
			'https://example.com/account/workflows/dynwf-path?selected=dynwf-query',
			'dynwf-param',
		),
	).toBe('dynwf-param')
	expect(
		readAccountWorkflowsSelectedWorkflowId(
			'https://example.com/account/workflows?selected=dynwf-query',
		),
	).toBe('dynwf-query')
})

test('loadAccountWorkflowsData lists workflows and resolves selected detail', async () => {
	const listed = [
		makeWorkflow({ id: 'dynwf-1', status: 'queued' }),
		makeWorkflow({
			id: 'pkgwf-1',
			sourceType: 'package',
			packageId: 'pkg-1',
			kodyId: 'kody-1',
			sourceId: 'source-1',
			workflowName: 'Package sync',
			exportName: 'nightly',
			status: 'complete',
			completedAt: '2026-07-28T12:05:00.000Z',
		}),
	]
	mockModule.listWorkflowRunsForUser.mockResolvedValueOnce(listed)
	mockModule.getWorkflowProjection.mockResolvedValueOnce(null)

	const payload = await loadAccountWorkflowsData({
		env: {} as Env,
		request: new Request(
			'https://example.com/account/workflows.json?selected=dynwf-1',
		),
		user,
	})

	expect(mockModule.listWorkflowRunsForUser).toHaveBeenCalledWith({
		env: expect.anything(),
		userId: 'stable-user-1',
		limit: 100,
	})
	expect(payload).toMatchObject({
		ok: true,
		selectedWorkflowId: 'dynwf-1',
		selectedWorkflow: expect.objectContaining({
			id: 'dynwf-1',
			sourceType: 'inline',
			workflowName: 'Deferred digest',
			status: 'queued',
		}),
		workflows: [
			expect.objectContaining({ id: 'dynwf-1', status: 'queued' }),
			expect.objectContaining({
				id: 'pkgwf-1',
				sourceType: 'package',
				packageId: 'pkg-1',
				status: 'complete',
			}),
		],
	})
})

test('loadAccountWorkflowsData loads selected projection when absent from list', async () => {
	mockModule.listWorkflowRunsForUser.mockResolvedValueOnce([])
	mockModule.getWorkflowProjection.mockResolvedValueOnce({
		id: 'dynwf-old',
		bindingName: 'DYNAMIC_CALLABLE_WORKFLOWS',
		sourceType: 'inline',
		packageId: null,
		kodyId: null,
		sourceId: null,
		workflowName: 'Stale run',
		exportName: null,
		idempotencyKey: 'idem-old',
		runAt: '2026-07-20T12:00:00.000Z',
		planDate: null,
		status: 'errored',
		createdAt: '2026-07-20T11:00:00.000Z',
		updatedAt: '2026-07-20T12:01:00.000Z',
		completedAt: '2026-07-20T12:01:00.000Z',
		lastError: 'boom',
	})

	const payload = await loadAccountWorkflowsData({
		env: {} as Env,
		request: new Request('https://example.com/account/workflows/dynwf-old'),
		user,
		pathWorkflowId: 'dynwf-old',
	})

	expect(mockModule.getWorkflowProjection).toHaveBeenCalledWith({
		env: expect.anything(),
		userId: 'stable-user-1',
		id: 'dynwf-old',
	})
	expect(payload.selectedWorkflow).toMatchObject({
		id: 'dynwf-old',
		workflowName: 'Stale run',
		status: 'errored',
		lastError: 'boom',
	})
})
