import { expect, test, vi } from 'vitest'
import { createMcpCallerContext } from '#mcp/context.ts'

const mockModule = vi.hoisted(() => ({
	getMcpSkillByName: vi.fn(),
	insertMcpSkill: vi.fn(),
	updateMcpSkill: vi.fn(),
	isDuplicateSkillNameError: vi.fn(),
	prepareSkillPersistence: vi.fn(),
	ensureEntitySource: vi.fn(),
	syncArtifactSourceSnapshot: vi.fn(),
	updateEntitySource: vi.fn(),
	upsertSkillVector: vi.fn(),
	deleteEntitySource: vi.fn(),
	deleteMcpSkill: vi.fn(),
}))

vi.mock('#mcp/skills/mcp-skills-repo.ts', () => ({
	getMcpSkillByName: (...args: Array<unknown>) =>
		mockModule.getMcpSkillByName(...args),
	insertMcpSkill: (...args: Array<unknown>) => mockModule.insertMcpSkill(...args),
	updateMcpSkill: (...args: Array<unknown>) => mockModule.updateMcpSkill(...args),
	isDuplicateSkillNameError: (...args: Array<unknown>) =>
		mockModule.isDuplicateSkillNameError(...args),
	deleteMcpSkill: (...args: Array<unknown>) => mockModule.deleteMcpSkill(...args),
}))

vi.mock('#mcp/skills/skill-mutation.ts', () => ({
	prepareSkillPersistence: (...args: Array<unknown>) =>
		mockModule.prepareSkillPersistence(...args),
	buildSkillEmbedTextFromStoredRow: vi.fn(),
}))

vi.mock('#worker/repo/source-service.ts', () => ({
	ensureEntitySource: (...args: Array<unknown>) =>
		mockModule.ensureEntitySource(...args),
}))

vi.mock('#worker/repo/source-sync.ts', () => ({
	syncArtifactSourceSnapshot: (...args: Array<unknown>) =>
		mockModule.syncArtifactSourceSnapshot(...args),
}))

vi.mock('#worker/repo/entity-sources.ts', () => ({
	updateEntitySource: (...args: Array<unknown>) =>
		mockModule.updateEntitySource(...args),
	deleteEntitySource: (...args: Array<unknown>) =>
		mockModule.deleteEntitySource(...args),
}))

vi.mock('#mcp/skills/skill-vectorize.ts', () => ({
	upsertSkillVector: (...args: Array<unknown>) => mockModule.upsertSkillVector(...args),
}))

const { metaSaveSkillCapability } = await import('./meta-save-skill.ts')

test('meta_save_skill forwards bootstrap access for a brand-new repo-backed skill publish', async () => {
	mockModule.getMcpSkillByName.mockReset()
	mockModule.insertMcpSkill.mockReset()
	mockModule.updateMcpSkill.mockReset()
	mockModule.isDuplicateSkillNameError.mockReset()
	mockModule.prepareSkillPersistence.mockReset()
	mockModule.ensureEntitySource.mockReset()
	mockModule.syncArtifactSourceSnapshot.mockReset()
	mockModule.updateEntitySource.mockReset()
	mockModule.upsertSkillVector.mockReset()
	mockModule.deleteEntitySource.mockReset()
	mockModule.deleteMcpSkill.mockReset()

	mockModule.getMcpSkillByName.mockResolvedValue(null)
	mockModule.prepareSkillPersistence.mockResolvedValue({
		rowPayload: {
			name: 'fresh-repo-skill',
			title: 'Fresh repo skill',
			description: 'Persists a brand-new repo-backed skill.',
			collection_name: null,
			collection_slug: null,
			keywords: '["repo","skill"]',
			code: 'async () => ({ ok: true })',
			search_text: null,
			uses_capabilities: null,
			parameters: null,
			inferred_capabilities: '[]',
			inference_partial: 0,
			read_only: 1,
			idempotent: 1,
			destructive: 0,
		},
		embedText: 'Fresh repo skill',
		merged: [],
		inferencePartial: false,
		derived: {
			destructiveDerived: false,
			readOnlyDerived: true,
			idempotentDerived: true,
		},
		warnings: [],
	})
	mockModule.ensureEntitySource.mockResolvedValue({
		id: 'source-1',
		user_id: 'user-1',
		entity_kind: 'skill',
		entity_id: 'skill-1',
		repo_id: 'skill-skill-1',
		published_commit: null,
		indexed_commit: null,
		manifest_path: 'kody.json',
		source_root: '/',
		created_at: '2026-04-18T00:00:00.000Z',
		updated_at: '2026-04-18T00:00:00.000Z',
		bootstrapAccess: {
			defaultBranch: 'main',
			remote:
				'https://acct.artifacts.cloudflare.net/git/default/skill-skill-1.git',
			token: 'art_v1_bootstrap?expires=1760000000',
			expiresAt: '2025-10-09T08:53:20.000Z',
		},
	})
	mockModule.syncArtifactSourceSnapshot.mockResolvedValue('commit-bootstrap-1')
	mockModule.upsertSkillVector.mockResolvedValue(undefined)
	mockModule.insertMcpSkill.mockResolvedValue(undefined)
	mockModule.updateEntitySource.mockResolvedValue(true)

	const callerContext = createMcpCallerContext({
		baseUrl: 'https://heykody.dev',
		user: { userId: 'user-1', email: 'user@example.com' },
	})

	const result = await metaSaveSkillCapability.handler(
		{
			name: 'fresh-repo-skill',
			title: 'Fresh repo skill',
			description: 'Persists a brand-new repo-backed skill.',
			keywords: ['repo', 'skill'],
			code: 'async () => ({ ok: true })',
			read_only: true,
			idempotent: true,
			destructive: false,
		},
		{
			env: { APP_DB: {} } as Env,
			callerContext,
		},
	)

	expect(mockModule.ensureEntitySource).toHaveBeenCalledWith(
		expect.objectContaining({
			db: {},
			env: { APP_DB: {} },
			userId: 'user-1',
			entityKind: 'skill',
			entityId: expect.any(String),
			sourceRoot: '/',
		}),
	)
	expect(mockModule.syncArtifactSourceSnapshot).toHaveBeenCalledWith(
		expect.objectContaining({
			env: { APP_DB: {} },
			userId: 'user-1',
			baseUrl: 'https://heykody.dev',
			sourceId: 'source-1',
			bootstrapAccess: {
				defaultBranch: 'main',
				remote:
					'https://acct.artifacts.cloudflare.net/git/default/skill-skill-1.git',
				token: 'art_v1_bootstrap?expires=1760000000',
				expiresAt: '2025-10-09T08:53:20.000Z',
			},
			files: expect.objectContaining({
				'kody.json': expect.stringContaining('"kind": "skill"'),
				'src/skill.ts': 'async () => ({ ok: true })\n',
			}),
		}),
	)
	expect(mockModule.updateEntitySource).toHaveBeenCalledWith(
		{},
		expect.objectContaining({
			id: 'source-1',
			userId: 'user-1',
			publishedCommit: 'commit-bootstrap-1',
			indexedCommit: 'commit-bootstrap-1',
		}),
	)
	expect(result).toEqual({
		name: 'fresh-repo-skill',
		collection: null,
		collection_slug: null,
		inferred_capabilities: [],
		inference_partial: false,
		destructive_derived: false,
		read_only_derived: true,
		idempotent_derived: true,
	})
})
