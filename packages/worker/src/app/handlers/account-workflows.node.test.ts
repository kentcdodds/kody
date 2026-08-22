import { expect, test, vi } from 'vitest'

const listedWorkflow = {
	id: 'dynwf-1',
	userId: 'stable-user-1',
	bindingName: 'DYNAMIC_CALLABLE_WORKFLOWS' as const,
	sourceType: 'inline' as const,
	packageId: null,
	kodyId: null,
	sourceId: null,
	workflowName: 'Deferred digest',
	exportName: null,
	idempotencyKey: 'idem-1',
	runAt: '2026-07-28T12:00:00.000Z',
	planDate: '2026-07-28',
	status: 'queued' as const,
	createdAt: '2026-07-27T12:00:00.000Z',
	updatedAt: '2026-07-27T12:00:00.000Z',
	completedAt: null,
	lastError: null,
}

const mockModule = vi.hoisted(() => ({
	readAuthenticatedAppUser: vi.fn(async () => ({
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
	})),
	listWorkflowRunsForUser: vi.fn(),
	cancelWorkflowRunForUser: vi.fn(),
	getWorkflowProjection: vi.fn(),
}))

vi.mock('#app/authenticated-user.ts', () => ({
	readAuthenticatedAppUser: (...args: Array<unknown>) =>
		mockModule.readAuthenticatedAppUser(...args),
}))

vi.mock('#worker/package-runtime/package-workflows.ts', () => ({
	listWorkflowRunsForUser: (...args: Array<unknown>) =>
		mockModule.listWorkflowRunsForUser(...args),
	cancelWorkflowRunForUser: (...args: Array<unknown>) =>
		mockModule.cancelWorkflowRunForUser(...args),
}))

vi.mock('#worker/run-records/service.ts', () => ({
	getWorkflowProjection: (...args: Array<unknown>) =>
		mockModule.getWorkflowProjection(...args),
}))

const { createAccountWorkflowsApiHandler } =
	await import('#app/handlers/account-workflows.ts')

function createEnv() {
	return {} as Env
}

function resetList(workflows = [listedWorkflow]) {
	mockModule.listWorkflowRunsForUser.mockReset()
	mockModule.listWorkflowRunsForUser.mockResolvedValue(workflows)
	mockModule.getWorkflowProjection.mockReset()
	mockModule.getWorkflowProjection.mockResolvedValue(null)
	mockModule.cancelWorkflowRunForUser.mockReset()
}

test('workflows API lists runs and selected detail', async () => {
	resetList()
	const handler = createAccountWorkflowsApiHandler(createEnv())

	const listResponse = await handler.handler({
		request: new Request('https://example.com/account/workflows.json'),
	})
	expect(listResponse.status).toBe(200)
	expect(listResponse.headers.get('Cache-Control')).toBe('no-store')
	await expect(listResponse.json()).resolves.toMatchObject({
		ok: true,
		selectedWorkflowId: null,
		selectedWorkflow: null,
		workflows: [
			expect.objectContaining({
				id: 'dynwf-1',
				sourceType: 'inline',
				workflowName: 'Deferred digest',
				status: 'queued',
			}),
		],
	})

	resetList()
	const detailResponse = await handler.handler({
		request: new Request(
			'https://example.com/account/workflows.json?selected=dynwf-1',
		),
	})
	expect(detailResponse.status).toBe(200)
	await expect(detailResponse.json()).resolves.toMatchObject({
		ok: true,
		selectedWorkflowId: 'dynwf-1',
		selectedWorkflow: expect.objectContaining({
			id: 'dynwf-1',
			status: 'queued',
		}),
	})
})

test('workflows API cancels a non-terminal run', async () => {
	resetList()
	mockModule.cancelWorkflowRunForUser.mockResolvedValueOnce({
		outcome: 'cancelled',
		run: { ...listedWorkflow, status: 'cancelled' },
	})
	const handler = createAccountWorkflowsApiHandler(createEnv())

	const response = await handler.handler({
		request: new Request('https://example.com/account/workflows.json', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ action: 'cancel', id: 'dynwf-1' }),
		}),
	})
	expect(response.status).toBe(200)
	expect(mockModule.cancelWorkflowRunForUser).toHaveBeenCalledWith({
		env: expect.anything(),
		userId: 'stable-user-1',
		workflowRunId: 'dynwf-1',
	})
	await expect(response.json()).resolves.toMatchObject({
		ok: true,
		cancel: {
			cancelled: true,
			alreadyTerminal: false,
			status: 'cancelled',
		},
	})
})

test('workflows API rejects unauthenticated and invalid requests', async () => {
	mockModule.readAuthenticatedAppUser.mockResolvedValueOnce(null)
	const handler = createAccountWorkflowsApiHandler(createEnv())

	const unauthorized = await handler.handler({
		request: new Request('https://example.com/account/workflows.json'),
	})
	expect(unauthorized.status).toBe(401)

	mockModule.readAuthenticatedAppUser.mockResolvedValueOnce({
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
	})
	const methodNotAllowed = await handler.handler({
		request: new Request('https://example.com/account/workflows.json', {
			method: 'PUT',
		}),
	})
	expect(methodNotAllowed.status).toBe(405)

	const invalidAction = await handler.handler({
		request: new Request('https://example.com/account/workflows.json', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ action: 'nope' }),
		}),
	})
	expect(invalidAction.status).toBe(400)
	await expect(invalidAction.json()).resolves.toEqual({
		ok: false,
		error: 'Invalid action.',
	})
})
