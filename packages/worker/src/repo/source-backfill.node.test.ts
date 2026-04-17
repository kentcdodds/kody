import { expect, test, vi } from 'vitest'
import { type UiArtifactRow } from '#mcp/ui-artifacts-types.ts'

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

test('backfill leaves app sourceId unchanged when repo source persistence is unavailable', async () => {
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

	const appRow: UiArtifactRow = {
		id: 'app-1',
		user_id: 'user-1',
		title: 'Investigate orphaned source ids',
		description: 'Debug repro app',
		sourceId: null,
		clientCode: '<main>Hello</main>',
		serverCode: null,
		serverCodeId: 'server-code-1',
		parameters: null,
		hidden: true,
		created_at: '2026-04-17T00:00:00.000Z',
		updated_at: '2026-04-17T00:00:00.000Z',
	}

	mockModule.listUiArtifactsByUserId.mockResolvedValue([appRow])
	mockModule.listMcpSkillsByUserId.mockResolvedValue([])
	mockModule.listJobRowsByUserId.mockResolvedValue([])

	const db = {
		prepare() {
			return {
				bind() {
					return {
						async first() {
							return null
						},
					}
				},
			}
		},
	} as unknown as D1Database

	const result = await backfillRepoSources({
		env: {
			APP_DB: db,
		} as Env,
		userId: 'user-1',
		baseUrl: 'https://heykody.dev',
		dryRun: false,
		includeApps: true,
		includeSkills: false,
		includeJobs: false,
		reindex: false,
		syncAppRunners: false,
	})

	expect(result.apps.errors).toBe(1)
	expect(result.apps.results[0]).toEqual({
		kind: 'app',
		id: 'app-1',
		title: 'Investigate orphaned source ids',
		status: 'error',
		reason: 'Repo-backed source persistence requires ARTIFACTS bindings.',
		sourceId: null,
		publishedCommit: null,
	})
	expect(mockModule.updateUiArtifact).not.toHaveBeenCalled()
	expect(appRow.sourceId).toBeNull()
})
