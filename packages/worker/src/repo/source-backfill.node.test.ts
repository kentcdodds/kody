import { expect, test, vi } from 'vitest'

const mockModule = vi.hoisted(() => ({
	listUiArtifactsByUserId: vi.fn(),
	updateUiArtifact: vi.fn(),
	listMcpSkillsByUserId: vi.fn(),
	updateMcpSkill: vi.fn(),
	listJobRowsByUserId: vi.fn(),
	updateJobRow: vi.fn(),
	syncSavedAppRunnerFromDb: vi.fn(),
	reindexUiArtifactVectors: vi.fn(),
	reindexSkillVectors: vi.fn(),
	reindexJobVectors: vi.fn(),
}))

vi.mock('#mcp/ui-artifacts-repo.ts', () => ({
	listUiArtifactsByUserId: (...args: Array<unknown>) =>
		mockModule.listUiArtifactsByUserId(...args),
	updateUiArtifact: (...args: Array<unknown>) =>
		mockModule.updateUiArtifact(...args),
}))

vi.mock('#mcp/skills/mcp-skills-repo.ts', () => ({
	listMcpSkillsByUserId: (...args: Array<unknown>) =>
		mockModule.listMcpSkillsByUserId(...args),
	updateMcpSkill: (...args: Array<unknown>) =>
		mockModule.updateMcpSkill(...args),
}))

vi.mock('#worker/jobs/repo.ts', () => ({
	listJobRowsByUserId: (...args: Array<unknown>) =>
		mockModule.listJobRowsByUserId(...args),
	updateJobRow: (...args: Array<unknown>) => mockModule.updateJobRow(...args),
}))

vi.mock('#mcp/app-runner.ts', () => ({
	syncSavedAppRunnerFromDb: (...args: Array<unknown>) =>
		mockModule.syncSavedAppRunnerFromDb(...args),
}))

vi.mock('#mcp/ui-artifact-reindex.ts', () => ({
	reindexUiArtifactVectors: (...args: Array<unknown>) =>
		mockModule.reindexUiArtifactVectors(...args),
}))

vi.mock('#mcp/skills/skill-reindex.ts', () => ({
	reindexSkillVectors: (...args: Array<unknown>) =>
		mockModule.reindexSkillVectors(...args),
}))

vi.mock('#worker/jobs/job-reindex.ts', () => ({
	reindexJobVectors: (...args: Array<unknown>) =>
		mockModule.reindexJobVectors(...args),
}))

const { backfillRepoSources } = await import('./source-backfill.ts')

test('backfillRepoSources reports missing repo source support before mutating rows', async () => {
	mockModule.listUiArtifactsByUserId.mockReset()
	mockModule.updateUiArtifact.mockReset()
	mockModule.listMcpSkillsByUserId.mockReset()
	mockModule.updateMcpSkill.mockReset()
	mockModule.listJobRowsByUserId.mockReset()
	mockModule.updateJobRow.mockReset()
	mockModule.syncSavedAppRunnerFromDb.mockReset()
	mockModule.reindexUiArtifactVectors.mockReset()
	mockModule.reindexSkillVectors.mockReset()
	mockModule.reindexJobVectors.mockReset()

	mockModule.listUiArtifactsByUserId.mockResolvedValue([
		{
			id: 'app-1',
			user_id: 'user-1',
			title: 'App one',
			description: 'App description',
			sourceId: null,
			clientCode: '<main>app</main>',
			serverCode: null,
			serverCodeId: 'server-code-1',
			parameters: null,
			hidden: false,
			created_at: '2026-04-17T00:00:00.000Z',
			updated_at: '2026-04-17T00:00:00.000Z',
		},
	])
	mockModule.listMcpSkillsByUserId.mockResolvedValue([
		{
			id: 'skill-1',
			user_id: 'user-1',
			name: 'skill-one',
			title: 'Skill one',
			description: 'Skill description',
			collection_name: null,
			collection_slug: null,
			source_id: null,
			keywords: '[]',
			code: 'async () => ({ ok: true })',
			search_text: null,
			uses_capabilities: null,
			parameters: null,
			inferred_capabilities: '[]',
			inference_partial: 0,
			read_only: 0,
			idempotent: 0,
			destructive: 0,
			created_at: '2026-04-17T00:00:00.000Z',
			updated_at: '2026-04-17T00:00:00.000Z',
		},
	])
	mockModule.listJobRowsByUserId.mockResolvedValue([
		{
			record: {
				version: 1,
				id: 'job-1',
				userId: 'user-1',
				name: 'Job one',
				code: 'async () => ({ ok: true })',
				sourceId: null,
				publishedCommit: null,
				storageId: 'job:job-1',
				schedule: { type: 'once', runAt: '2026-04-18T00:00:00.000Z' },
				timezone: 'UTC',
				enabled: true,
				killSwitchEnabled: false,
				createdAt: '2026-04-17T00:00:00.000Z',
				updatedAt: '2026-04-17T00:00:00.000Z',
				nextRunAt: '2026-04-18T00:00:00.000Z',
				runCount: 0,
				successCount: 0,
				errorCount: 0,
				runHistory: [],
			},
			callerContextJson: 'null',
		},
	])

	const result = await backfillRepoSources({
		env: {
			APP_DB: {
				prepare() {
					throw new Error('prepare should not be called during the blocked run')
				},
			},
		} as unknown as Env,
		userId: 'user-1',
		baseUrl: 'https://heykody.dev',
		dryRun: false,
	})

	expect(result).toMatchObject({
		dryRun: false,
		apps: { total: 1, errors: 1, migrated: 0, skipped: 0, planned: 0 },
		skills: { total: 1, errors: 1, migrated: 0, skipped: 0, planned: 0 },
		jobs: { total: 1, errors: 1, migrated: 0, skipped: 0, planned: 0 },
		reindex: null,
	})
	expect(result.apps.results[0]?.reason).toBe(
		'Repo-backed source support is unavailable in this environment. Missing required bindings: ARTIFACTS, REPO_SESSION.',
	)
	expect(result.skills.results[0]?.reason).toBe(
		'Repo-backed source support is unavailable in this environment. Missing required bindings: ARTIFACTS, REPO_SESSION.',
	)
	expect(result.jobs.results[0]?.reason).toBe(
		'Repo-backed source support is unavailable in this environment. Missing required bindings: ARTIFACTS, REPO_SESSION.',
	)
	expect(mockModule.updateUiArtifact).not.toHaveBeenCalled()
	expect(mockModule.updateMcpSkill).not.toHaveBeenCalled()
	expect(mockModule.updateJobRow).not.toHaveBeenCalled()
	expect(mockModule.syncSavedAppRunnerFromDb).not.toHaveBeenCalled()
	expect(mockModule.reindexUiArtifactVectors).not.toHaveBeenCalled()
	expect(mockModule.reindexSkillVectors).not.toHaveBeenCalled()
	expect(mockModule.reindexJobVectors).not.toHaveBeenCalled()
})
