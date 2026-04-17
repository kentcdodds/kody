import { expect, test, vi } from 'vitest'
import { createMcpCallerContext } from '#mcp/context.ts'

const mockModule = vi.hoisted(() => ({
	backfillRepoSources: vi.fn(),
}))

vi.mock('#worker/repo/source-backfill.ts', () => ({
	backfillRepoSources: (...args: Array<unknown>) =>
		mockModule.backfillRepoSources(...args),
}))

const { repoBackfillSourcesCapability } = await import('./repo-backfill-sources.ts')

test('repo_backfill_sources requires an authenticated user', async () => {
	await expect(
		repoBackfillSourcesCapability.handler(
			{},
			{
				env: {} as Env,
				callerContext: createMcpCallerContext({
					baseUrl: 'https://heykody.dev',
				}),
			},
		),
	).rejects.toThrow('repo_backfill_sources requires an authenticated user.')
})

test('repo_backfill_sources delegates to the backfill service', async () => {
	mockModule.backfillRepoSources.mockReset()
	mockModule.backfillRepoSources.mockResolvedValueOnce({
		dryRun: false,
		apps: { total: 1, planned: 0, migrated: 1, skipped: 0, errors: 0, results: [] },
		skills: {
			total: 2,
			planned: 0,
			migrated: 2,
			skipped: 0,
			errors: 0,
			results: [],
		},
		jobs: { total: 1, planned: 0, migrated: 1, skipped: 0, errors: 0, results: [] },
		reindex: { apps: 1, skills: 2, jobs: 1 },
	})

	const result = await repoBackfillSourcesCapability.handler(
		{
			dry_run: false,
			include_apps: true,
			include_skills: true,
			include_jobs: true,
			reindex: true,
			sync_app_runners: true,
		},
		{
			env: {} as Env,
			callerContext: createMcpCallerContext({
				baseUrl: 'https://heykody.dev',
				user: { userId: 'user-123', email: 'user@example.com' },
			}),
		},
	)

	expect(mockModule.backfillRepoSources).toHaveBeenCalledWith({
		env: {},
		userId: 'user-123',
		baseUrl: 'https://heykody.dev',
		dryRun: false,
		includeApps: true,
		includeSkills: true,
		includeJobs: true,
		reindex: true,
		syncAppRunners: true,
	})
	expect(result).toEqual({
		dryRun: false,
		apps: { total: 1, planned: 0, migrated: 1, skipped: 0, errors: 0, results: [] },
		skills: {
			total: 2,
			planned: 0,
			migrated: 2,
			skipped: 0,
			errors: 0,
			results: [],
		},
		jobs: { total: 1, planned: 0, migrated: 1, skipped: 0, errors: 0, results: [] },
		reindex: { apps: 1, skills: 2, jobs: 1 },
	})
})
