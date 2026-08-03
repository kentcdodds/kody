import { expect, test, vi } from 'vitest'
import { createMcpCallerContext } from '#mcp/context.ts'

const mockModule = vi.hoisted(() => ({
	repoSessionRpc: vi.fn(),
}))

vi.mock('#worker/repo/repo-session-do.ts', () => ({
	repoSessionRpc: (...args: Array<unknown>) =>
		mockModule.repoSessionRpc(...args),
}))

const { repoCommitCapability } = await import('./repo-commit.ts')

function createCapabilityContext() {
	return {
		env: { APP_DB: {} } as Env,
		callerContext: createMcpCallerContext({
			baseUrl: 'https://heykody.dev',
			user: { userId: 'user-1', email: 'user@example.com' },
		}),
	}
}

test('repo_commit forwards session commit with message', async () => {
	mockModule.repoSessionRpc.mockReset()
	const sessionCommit = vi.fn().mockResolvedValueOnce({
		oid: 'commit-abc',
		message: 'Ship it',
	})
	mockModule.repoSessionRpc.mockReturnValue({ sessionCommit })

	const result = await repoCommitCapability.handler(
		{
			session_id: 'session-1',
			message: 'Ship it',
		},
		createCapabilityContext(),
	)

	expect(mockModule.repoSessionRpc).toHaveBeenCalledWith(
		expect.anything(),
		'session-1',
	)
	expect(sessionCommit).toHaveBeenCalledWith({
		sessionId: 'session-1',
		userId: 'user-1',
		message: 'Ship it',
	})
	expect(result).toEqual({ oid: 'commit-abc', message: 'Ship it' })
})
