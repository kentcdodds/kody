import { expect, test, vi } from 'vitest'
import { startAgentTurnRun } from './service.ts'

function createEnv(response: Response) {
	const stub = {
		fetch: vi.fn(async () => response),
	}
	return {
		env: {
			AGENT_TURN_RUNNER: {
				idFromName: vi.fn((name: string) => name as unknown as DurableObjectId),
				get: vi.fn(() => stub),
			},
		} as unknown as Env,
		stub,
	}
}

test('startAgentTurnRun preserves structured Durable Object conflict errors', async () => {
	const { env } = createEnv(
		Response.json(
			{
				ok: false,
				error: 'An agent turn is already active for this session.',
			},
			{ status: 409 },
		),
	)

	await expect(
		startAgentTurnRun({
			env,
			sessionId: 'session-123',
			callerContext: {
				baseUrl: 'https://heykody.dev',
				user: { userId: 'user-123' },
				homeConnectorId: null,
				remoteConnectors: null,
				storageContext: null,
			},
			turn: {
				sessionId: 'session-123',
				system: 'system',
				messages: [{ role: 'user', content: 'hello' }],
			},
		}),
	).rejects.toThrow('An agent turn is already active for this session.')
})
