import { expect, test, vi } from 'vitest'

const mockModule = vi.hoisted(() => ({
	listRepoSessionsForBranchCleanup: vi.fn(),
	cleanupSessionBranch: vi.fn(async () => ({ ok: true })),
}))

vi.mock('./repo-sessions.ts', () => ({
	listRepoSessionsForBranchCleanup: (...args: Array<unknown>) =>
		mockModule.listRepoSessionsForBranchCleanup(...args),
}))

vi.mock('./repo-session-do.ts', () => ({
	repoSessionRpc: () => ({
		cleanupSessionBranch: (...args: Array<unknown>) =>
			mockModule.cleanupSessionBranch(...args),
	}),
}))

const { cleanupRepoSessionBranches } = await import('./repo-session-cleanup.ts')

test('repo session branch cleanup deletes expired and abandoned session branches', async () => {
	mockModule.listRepoSessionsForBranchCleanup.mockResolvedValue([
		session({ id: 'published-session', status: 'published' }),
		session({ id: 'active-session', status: 'active' }),
	])

	const result = await cleanupRepoSessionBranches({
		env: { APP_DB: {} } as Env,
		now: new Date('2026-06-24T20:00:00.000Z'),
		batchSize: 10,
	})

	expect(mockModule.listRepoSessionsForBranchCleanup).toHaveBeenCalledWith(
		expect.anything(),
		{
			now: '2026-06-24T20:00:00.000Z',
			abandonedBefore: '2026-06-17T20:00:00.000Z',
			limit: 10,
		},
	)
	expect(mockModule.cleanupSessionBranch).toHaveBeenNthCalledWith(1, {
		sessionId: 'published-session',
		userId: 'user-1',
		reason: 'expired',
	})
	expect(mockModule.cleanupSessionBranch).toHaveBeenNthCalledWith(2, {
		sessionId: 'active-session',
		userId: 'user-1',
		reason: 'abandoned',
	})
	expect(result).toEqual({
		checked: 2,
		deleted: 2,
		errors: 0,
	})
})

function session(input: { id: string; status: 'active' | 'published' }) {
	return {
		id: input.id,
		user_id: 'user-1',
		source_id: 'source-1',
		source_repo_id: 'source-repo',
		session_branch: `sessions/${input.id}`,
		source_branch: 'main',
		status: input.status,
	}
}
