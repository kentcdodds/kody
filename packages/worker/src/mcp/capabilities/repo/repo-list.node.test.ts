import { expect, test, vi } from 'vitest'
import { createMcpCallerContext } from '#mcp/context.ts'

const mockModule = vi.hoisted(() => ({
	listUserRepos: vi.fn(),
}))

vi.mock('#worker/repo/user-repos.ts', () => ({
	listUserRepos: (...args: Array<unknown>) => mockModule.listUserRepos(...args),
}))

const { repoListCapability } = await import('./repo-list.ts')

function createContext(userId = 'user-1') {
	return {
		env: { APP_DB: {} } as Env,
		callerContext: createMcpCallerContext({
			baseUrl: 'https://kody.test',
			user: {
				userId,
				email: `${userId}@example.com`,
				displayName: userId,
			},
		}),
	}
}

test('repoList includes owner identity icon URLs from indexed commits', async () => {
	mockModule.listUserRepos.mockResolvedValue([
		{
			id: 'repo-1',
			userId: 'user-1',
			name: 'notes',
			description: 'Notes',
			isPrivate: true,
			iconCommit: 'idx-1',
			createdAt: '2026-07-10T00:00:00.000Z',
			updatedAt: '2026-07-11T00:00:00.000Z',
		},
		{
			id: 'repo-2',
			userId: 'user-1',
			name: 'empty',
			description: null,
			isPrivate: false,
			iconCommit: null,
			createdAt: '2026-07-10T00:00:00.000Z',
			updatedAt: '2026-07-11T00:00:00.000Z',
		},
	])

	const result = await repoListCapability.handler({}, createContext())
	expect(result.repos).toEqual([
		{
			repo_id: 'repo-1',
			name: 'notes',
			description: 'Notes',
			visibility: 'private',
			icon_url: '/account/repos/repo-1/icon/idx-1',
			created_at: '2026-07-10T00:00:00.000Z',
			updated_at: '2026-07-11T00:00:00.000Z',
		},
		{
			repo_id: 'repo-2',
			name: 'empty',
			description: null,
			visibility: 'public',
			icon_url: null,
			created_at: '2026-07-10T00:00:00.000Z',
			updated_at: '2026-07-11T00:00:00.000Z',
		},
	])
})
