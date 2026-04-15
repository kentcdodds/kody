import { beforeEach, expect, test, vi } from 'vitest'

const mockModule = vi.hoisted(() => ({
	resolveSkillRunnerUserByToken: vi.fn(),
	markSkillRunnerTokenUsed: vi.fn(async () => true),
	runSavedSkill: vi.fn(),
}))

vi.mock('#mcp/values/skill-runner-tokens.ts', () => ({
	resolveSkillRunnerUserByToken: (...args: Array<unknown>) =>
		mockModule.resolveSkillRunnerUserByToken(...args),
	markSkillRunnerTokenUsed: (...args: Array<unknown>) =>
		mockModule.markSkillRunnerTokenUsed(...args),
}))

vi.mock('#mcp/skills/run-saved-skill.ts', () => ({
	runSavedSkill: (...args: Array<unknown>) => mockModule.runSavedSkill(...args),
}))

const { apiHandler } = await import('./oauth-handlers.ts')

function createRequest(
	body: Record<string, unknown>,
	headers?: Record<string, string>,
) {
	return new Request('https://example.com/api/skills/run', {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			...headers,
		},
		body: JSON.stringify(body),
	})
}

beforeEach(() => {
	vi.clearAllMocks()
})

test('api skill runner rejects missing bearer auth', async () => {
	const response = await apiHandler.fetch(
		createRequest({ name: 'discord-event-handler', params: {} }),
		{ APP_DB: {} as D1Database } as Env,
		{} as ExecutionContext,
	)

	expect(response.status).toBe(401)
	await expect(response.json()).resolves.toEqual({
		ok: false,
		error: 'Unauthorized.',
	})
	expect(mockModule.resolveSkillRunnerUserByToken).not.toHaveBeenCalled()
	expect(mockModule.runSavedSkill).not.toHaveBeenCalled()
})

test('api skill runner rejects invalid tokens', async () => {
	mockModule.resolveSkillRunnerUserByToken.mockResolvedValueOnce(null)

	const response = await apiHandler.fetch(
		createRequest(
			{ name: 'discord-event-handler', params: {} },
			{ Authorization: 'Bearer tok_invalid' },
		),
		{ APP_DB: {} as D1Database } as Env,
		{} as ExecutionContext,
	)

	expect(response.status).toBe(401)
	await expect(response.json()).resolves.toEqual({
		ok: false,
		error: 'Unauthorized.',
	})
	expect(mockModule.markSkillRunnerTokenUsed).not.toHaveBeenCalled()
	expect(mockModule.runSavedSkill).not.toHaveBeenCalled()
})

test('api skill runner validates request payloads after auth', async () => {
	const env = { APP_DB: {} as D1Database } as Env
	mockModule.resolveSkillRunnerUserByToken.mockResolvedValueOnce({
		userId: 'user-123',
		clientName: 'kody-discord-gateway',
	})

	const response = await apiHandler.fetch(
		createRequest(
			{ name: 'discord-event-handler', params: [] },
			{ Authorization: 'Bearer tok_valid' },
		),
		env,
		{} as ExecutionContext,
	)

	expect(response.status).toBe(400)
	await expect(response.json()).resolves.toEqual({
		ok: false,
		error: 'Skill params must be a JSON object when provided.',
	})
	expect(mockModule.markSkillRunnerTokenUsed).toHaveBeenCalledWith({
		env,
		userId: 'user-123',
		clientName: 'kody-discord-gateway',
	})
	expect(mockModule.runSavedSkill).not.toHaveBeenCalled()
})

test('api skill runner returns successful saved skill results and marks usage', async () => {
	mockModule.resolveSkillRunnerUserByToken.mockResolvedValueOnce({
		userId: 'user-123',
		clientName: 'kody-discord-gateway',
	})
	mockModule.runSavedSkill.mockResolvedValueOnce({
		ok: true,
		result: { ok: true, echoed: { eventType: 'MESSAGE_CREATE' } },
		logs: [],
	})
	const env = { APP_DB: {} as D1Database } as Env

	const response = await apiHandler.fetch(
		createRequest(
			{
				name: 'discord-event-handler',
				params: { eventType: 'MESSAGE_CREATE' },
			},
			{ Authorization: 'Bearer tok_valid' },
		),
		env,
		{} as ExecutionContext,
	)

	expect(response.status).toBe(200)
	await expect(response.json()).resolves.toEqual({
		ok: true,
		result: { ok: true, echoed: { eventType: 'MESSAGE_CREATE' } },
	})
	expect(mockModule.markSkillRunnerTokenUsed).toHaveBeenCalledWith({
		env,
		userId: 'user-123',
		clientName: 'kody-discord-gateway',
	})
	expect(mockModule.runSavedSkill).toHaveBeenCalledWith({
		env,
		callerContext: {
			baseUrl: 'https://example.com',
			user: {
				userId: 'user-123',
				email: 'skill-runner@local.invalid',
				displayName: 'skill-runner',
			},
			homeConnectorId: null,
			remoteConnectors: null,
			storageContext: null,
		},
		name: 'discord-event-handler',
		params: { eventType: 'MESSAGE_CREATE' },
	})
})

test('api skill runner surfaces structured saved skill failures without throwing', async () => {
	mockModule.resolveSkillRunnerUserByToken.mockResolvedValueOnce({
		userId: 'user-123',
		clientName: 'kody-discord-gateway',
	})
	mockModule.runSavedSkill.mockResolvedValueOnce({
		ok: false,
		error: 'Skill not found for this user.',
		logs: [],
	})

	const response = await apiHandler.fetch(
		createRequest(
			{
				name: 'missing-skill',
				params: {},
			},
			{ Authorization: 'Bearer tok_valid' },
		),
		{ APP_DB: {} as D1Database } as Env,
		{} as ExecutionContext,
	)

	expect(response.status).toBe(200)
	await expect(response.json()).resolves.toEqual({
		ok: false,
		error: 'Skill not found for this user.',
	})
})
