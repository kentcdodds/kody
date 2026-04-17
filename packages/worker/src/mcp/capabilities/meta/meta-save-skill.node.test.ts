import { expect, test, vi } from 'vitest'
import { createMcpCallerContext } from '#mcp/context.ts'

const mockModule = vi.hoisted(() => ({
	getMcpSkillByName: vi.fn(),
	insertMcpSkill: vi.fn(),
	updateMcpSkill: vi.fn(),
	deleteMcpSkill: vi.fn(),
	upsertSkillVector: vi.fn(),
	prepareSkillPersistence: vi.fn(),
	buildSkillEmbedTextFromStoredRow: vi.fn(),
	ensureEntitySource: vi.fn(),
	syncArtifactSourceSnapshot: vi.fn(),
	setEntityPublishedCommit: vi.fn(),
	deleteEntitySource: vi.fn(),
}))

vi.mock('#mcp/skills/mcp-skills-repo.ts', () => ({
	getMcpSkillByName: (...args: Array<unknown>) =>
		mockModule.getMcpSkillByName(...args),
	insertMcpSkill: (...args: Array<unknown>) =>
		mockModule.insertMcpSkill(...args),
	updateMcpSkill: (...args: Array<unknown>) =>
		mockModule.updateMcpSkill(...args),
	deleteMcpSkill: (...args: Array<unknown>) =>
		mockModule.deleteMcpSkill(...args),
	isDuplicateSkillNameError: () => false,
}))

vi.mock('#mcp/skills/skill-vectorize.ts', () => ({
	upsertSkillVector: (...args: Array<unknown>) =>
		mockModule.upsertSkillVector(...args),
}))

vi.mock('#mcp/skills/skill-mutation.ts', () => ({
	prepareSkillPersistence: (...args: Array<unknown>) =>
		mockModule.prepareSkillPersistence(...args),
	buildSkillEmbedTextFromStoredRow: (...args: Array<unknown>) =>
		mockModule.buildSkillEmbedTextFromStoredRow(...args),
}))

vi.mock('#worker/repo/source-service.ts', () => ({
	ensureEntitySource: (...args: Array<unknown>) =>
		mockModule.ensureEntitySource(...args),
	setEntityPublishedCommit: (...args: Array<unknown>) =>
		mockModule.setEntityPublishedCommit(...args),
}))

vi.mock('#worker/repo/source-sync.ts', () => ({
	syncArtifactSourceSnapshot: (...args: Array<unknown>) =>
		mockModule.syncArtifactSourceSnapshot(...args),
}))

vi.mock('#worker/repo/entity-sources.ts', () => ({
	deleteEntitySource: (...args: Array<unknown>) =>
		mockModule.deleteEntitySource(...args),
}))

const { metaSaveSkillCapability } = await import('./meta-save-skill.ts')

function createPreparedPersistence() {
	return {
		rowPayload: {
			name: 'deploy-worker',
			title: 'Deploy Worker',
			description: 'Deploys the worker',
			collection_name: null,
			collection_slug: null,
			keywords: '["deploy"]',
			search_text: null,
			uses_capabilities: null,
			parameters: null,
			inferred_capabilities: '[]',
			inference_partial: 0,
			read_only: 1,
			idempotent: 1,
			destructive: 0,
		},
		embedText: 'Deploy Worker\nDeploys the worker',
		merged: [],
		inferencePartial: false,
		derived: {
			destructiveDerived: false,
			readOnlyDerived: true,
			idempotentDerived: true,
		},
		warnings: [],
	}
}

test('meta_save_skill stores metadata and publishes repo-backed source', async () => {
	mockModule.getMcpSkillByName.mockReset()
	mockModule.insertMcpSkill.mockReset()
	mockModule.updateMcpSkill.mockReset()
	mockModule.deleteMcpSkill.mockReset()
	mockModule.upsertSkillVector.mockReset()
	mockModule.prepareSkillPersistence.mockReset()
	mockModule.ensureEntitySource.mockReset()
	mockModule.syncArtifactSourceSnapshot.mockReset()
	mockModule.setEntityPublishedCommit.mockReset()

	mockModule.getMcpSkillByName.mockResolvedValue(null)
	mockModule.prepareSkillPersistence.mockResolvedValue(createPreparedPersistence())
	mockModule.ensureEntitySource.mockResolvedValue({
		id: 'source-1',
		published_commit: null,
	})
	mockModule.syncArtifactSourceSnapshot.mockResolvedValue('commit-1')
	mockModule.insertMcpSkill.mockResolvedValue(undefined)
	mockModule.upsertSkillVector.mockResolvedValue(undefined)

	const result = await metaSaveSkillCapability.handler(
		{
			name: 'deploy-worker',
			title: 'Deploy Worker',
			description: 'Deploys the worker',
			keywords: ['deploy'],
			code: 'async () => ({ ok: true })',
			read_only: true,
			idempotent: true,
			destructive: false,
		},
		{
			env: { APP_DB: {} } as Env,
			callerContext: createMcpCallerContext({
				baseUrl: 'https://heykody.dev',
				user: { userId: 'user-1', email: 'user@example.com' },
			}),
		},
	)

	expect(result).toEqual({
		name: 'deploy-worker',
		collection: null,
		collection_slug: null,
		inferred_capabilities: [],
		inference_partial: false,
		destructive_derived: false,
		read_only_derived: true,
		idempotent_derived: true,
	})
	expect(mockModule.insertMcpSkill).toHaveBeenCalledWith(
		{},
		expect.objectContaining({
			source_id: 'source-1',
			name: 'deploy-worker',
		}),
	)
	expect(mockModule.setEntityPublishedCommit).toHaveBeenCalledWith({
		db: {},
		userId: 'user-1',
		sourceId: 'source-1',
		publishedCommit: 'commit-1',
		indexedCommit: 'commit-1',
	})
})
