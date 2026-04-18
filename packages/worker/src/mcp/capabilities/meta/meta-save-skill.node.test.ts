import { expect, test, vi } from 'vitest'
import { createMcpCallerContext } from '#mcp/context.ts'

const mockModule = vi.hoisted(() => ({
	deleteEntitySource: vi.fn(),
	updateEntitySource: vi.fn(),
	deleteMcpSkill: vi.fn(),
	getMcpSkillByName: vi.fn(),
	insertMcpSkill: vi.fn(),
	isDuplicateSkillNameError: vi.fn(() => false),
	updateMcpSkill: vi.fn(),
	buildSkillEmbedTextFromStoredRow: vi.fn(),
	prepareSkillPersistence: vi.fn(),
	upsertSkillVector: vi.fn(),
	syncArtifactSourceSnapshot: vi.fn(),
	buildSkillSourceFiles: vi.fn(),
	ensureEntitySource: vi.fn(),
}))

vi.mock('#worker/repo/entity-sources.ts', () => ({
	deleteEntitySource: (...args: Array<unknown>) =>
		mockModule.deleteEntitySource(...args),
	updateEntitySource: (...args: Array<unknown>) =>
		mockModule.updateEntitySource(...args),
}))

vi.mock('#mcp/skills/mcp-skills-repo.ts', () => ({
	deleteMcpSkill: (...args: Array<unknown>) => mockModule.deleteMcpSkill(...args),
	getMcpSkillByName: (...args: Array<unknown>) =>
		mockModule.getMcpSkillByName(...args),
	insertMcpSkill: (...args: Array<unknown>) => mockModule.insertMcpSkill(...args),
	isDuplicateSkillNameError: (...args: Array<unknown>) =>
		mockModule.isDuplicateSkillNameError(...args),
	updateMcpSkill: (...args: Array<unknown>) => mockModule.updateMcpSkill(...args),
}))

vi.mock('#mcp/skills/skill-mutation.ts', () => ({
	buildSkillEmbedTextFromStoredRow: (...args: Array<unknown>) =>
		mockModule.buildSkillEmbedTextFromStoredRow(...args),
	prepareSkillPersistence: (...args: Array<unknown>) =>
		mockModule.prepareSkillPersistence(...args),
}))

vi.mock('#mcp/skills/skill-vectorize.ts', () => ({
	upsertSkillVector: (...args: Array<unknown>) =>
		mockModule.upsertSkillVector(...args),
}))

vi.mock('#worker/repo/source-sync.ts', () => ({
	syncArtifactSourceSnapshot: (...args: Array<unknown>) =>
		mockModule.syncArtifactSourceSnapshot(...args),
}))

vi.mock('#worker/repo/source-templates.ts', () => ({
	buildSkillSourceFiles: (...args: Array<unknown>) =>
		mockModule.buildSkillSourceFiles(...args),
}))

vi.mock('#worker/repo/source-service.ts', () => ({
	ensureEntitySource: (...args: Array<unknown>) =>
		mockModule.ensureEntitySource(...args),
}))

const { metaSaveSkillCapability } = await import('./meta-save-skill.ts')

test('meta_save_skill deletes newly written source references when source sync fails', async () => {
	mockModule.deleteEntitySource.mockReset()
	mockModule.updateEntitySource.mockReset()
	mockModule.deleteMcpSkill.mockReset()
	mockModule.getMcpSkillByName.mockReset()
	mockModule.insertMcpSkill.mockReset()
	mockModule.isDuplicateSkillNameError.mockReset()
	mockModule.updateMcpSkill.mockReset()
	mockModule.buildSkillEmbedTextFromStoredRow.mockReset()
	mockModule.prepareSkillPersistence.mockReset()
	mockModule.upsertSkillVector.mockReset()
	mockModule.syncArtifactSourceSnapshot.mockReset()
	mockModule.buildSkillSourceFiles.mockReset()
	mockModule.ensureEntitySource.mockReset()

	mockModule.getMcpSkillByName.mockResolvedValue(null)
	mockModule.isDuplicateSkillNameError.mockReturnValue(false)
	mockModule.prepareSkillPersistence.mockResolvedValue({
		merged: ['repo_open_session'],
		inferencePartial: false,
		derived: {
			destructiveDerived: false,
			readOnlyDerived: false,
			idempotentDerived: true,
		},
		warnings: [],
		embedText: 'Skill embed text',
		rowPayload: {
			name: 'test-skill',
			title: 'Test skill',
			description: 'Skill used to test source rollback',
			collection_name: null,
			collection_slug: null,
			keywords: '["repo"]',
			code: 'async () => "ok"',
			search_text: null,
			uses_capabilities: null,
			parameters: null,
			inferred_capabilities: '["repo_open_session"]',
			inference_partial: 0,
			read_only: 0,
			idempotent: 1,
			destructive: 0,
		},
	})
	mockModule.ensureEntitySource.mockResolvedValue({
		id: 'source-1',
		user_id: 'user-1',
		entity_kind: 'skill',
		entity_id: 'skill-1',
		repo_id: 'repo-1',
		published_commit: null,
		indexed_commit: null,
		manifest_path: 'kody.json',
		source_root: '/',
		created_at: '2026-04-18T00:00:00.000Z',
		updated_at: '2026-04-18T00:00:00.000Z',
	})
	mockModule.buildSkillSourceFiles.mockReturnValue({
		'kody.json': '{"version":1}',
		'src/skill.ts': 'async () => "ok"',
	})
	mockModule.syncArtifactSourceSnapshot.mockRejectedValue(
		new Error('bootstrap publish failed'),
	)

	const db = {} as D1Database

	await expect(
		metaSaveSkillCapability.handler(
			{
				name: 'test-skill',
				title: 'Test skill',
				description: 'Skill used to test source rollback',
				keywords: ['repo'],
				code: 'async () => "ok"',
				read_only: false,
				idempotent: true,
				destructive: false,
			},
			{
				env: { APP_DB: db } as Env,
				callerContext: createMcpCallerContext({
					baseUrl: 'https://heykody.dev',
					user: { userId: 'user-1', email: 'user@example.com' },
				}),
			},
		),
	).rejects.toThrow('bootstrap publish failed')

	expect(mockModule.insertMcpSkill).toHaveBeenCalledWith(
		db,
		expect.objectContaining({
			user_id: 'user-1',
			source_id: 'source-1',
			name: 'test-skill',
		}),
	)
	expect(mockModule.syncArtifactSourceSnapshot).toHaveBeenCalledWith({
		env: { APP_DB: db },
		userId: 'user-1',
		baseUrl: 'https://heykody.dev',
		sourceId: 'source-1',
		files: {
			'kody.json': '{"version":1}',
			'src/skill.ts': 'async () => "ok"',
		},
	})
	expect(mockModule.deleteMcpSkill).toHaveBeenCalledWith(
		db,
		'user-1',
		'test-skill',
	)
	expect(mockModule.deleteEntitySource).toHaveBeenCalledWith(db, {
		id: 'source-1',
		userId: 'user-1',
	})
	expect(mockModule.updateEntitySource).not.toHaveBeenCalled()
	expect(mockModule.upsertSkillVector).not.toHaveBeenCalled()
})
