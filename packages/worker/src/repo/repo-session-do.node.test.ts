import { expect, test, vi } from 'vitest'

const mockModule = vi.hoisted(() => ({
	resolveArtifactSourceRepo: vi.fn(),
	getArtifactsBinding: vi.fn(),
}))

vi.mock('./artifacts.ts', async () => {
	const actual = await vi.importActual<typeof import('./artifacts.ts')>(
		'./artifacts.ts',
	)
	return {
		...actual,
		resolveArtifactSourceRepo: (...args: Array<unknown>) =>
			mockModule.resolveArtifactSourceRepo(...args),
		getArtifactsBinding: (...args: Array<unknown>) =>
			mockModule.getArtifactsBinding(...args),
	}
})

const { createSessionRepoForSource } = await import('./repo-session-do.ts')

test('createSessionRepoForSource creates a blank session repo for unpublished sources', async () => {
	mockModule.resolveArtifactSourceRepo.mockReset()
	mockModule.getArtifactsBinding.mockReset()

	const create = vi.fn(async (name: string) => ({
		id: 'session-repo-1',
		name,
		description: null,
		defaultBranch: 'main',
		remote: `https://acct.artifacts.cloudflare.net/git/default/${name}.git`,
		token: 'art_v1_create?expires=1760000000',
		expiresAt: '2026-10-09T08:53:20.000Z',
	}))
	mockModule.getArtifactsBinding.mockReturnValue({
		create,
	} as never)

	await expect(
		createSessionRepoForSource({
			env: {} as Env,
			source: {
				repo_id: 'app-source-1',
				published_commit: null,
			},
			sessionId: 'session-1',
		}),
	).resolves.toMatchObject({
		sessionRepoId: 'session-repo-1',
		sessionRepoName: 'app-source-1-session1',
		baseCommit: null,
	})

	expect(create).toHaveBeenCalledTimes(1)
	expect(mockModule.resolveArtifactSourceRepo).not.toHaveBeenCalled()
})

test('createSessionRepoForSource forks published sources', async () => {
	mockModule.resolveArtifactSourceRepo.mockReset()
	mockModule.getArtifactsBinding.mockReset()

	const fork = vi.fn(async (input: { name: string; readOnly?: boolean }) => ({
		id: 'forked-session-1',
		name: input.name,
		description: null,
		defaultBranch: 'main',
		remote: `https://acct.artifacts.cloudflare.net/git/default/${input.name}.git`,
		token: 'art_v1_fork?expires=1760000200',
		expiresAt: '2026-10-09T08:56:40.000Z',
		repo: {} as never,
	}))
	mockModule.resolveArtifactSourceRepo.mockResolvedValue({
		fork,
	} as never)

	await expect(
		createSessionRepoForSource({
			env: {} as Env,
			source: {
				repo_id: 'skill-source-1',
				published_commit: 'commit-123',
			},
			sessionId: 'session-2',
		}),
	).resolves.toMatchObject({
		sessionRepoId: 'forked-session-1',
		sessionRepoName: 'skill-source-1-session2',
		baseCommit: 'commit-123',
	})

	expect(mockModule.resolveArtifactSourceRepo).toHaveBeenCalledTimes(1)
	expect(fork).toHaveBeenCalledTimes(1)
	expect(mockModule.getArtifactsBinding).not.toHaveBeenCalled()
})
