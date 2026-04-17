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

const { metaSaveSkillCapability } = await import('./meta-save-skill.ts')

test('meta_save_skill keeps new skills inline-only when repo source support is unavailable', async () => {
	mockModule.getMcpSkillByName.mockReset()
	mockModule.insertMcpSkill.mockReset()
	mockModule.updateMcpSkill.mockReset()
	mockModule.deleteMcpSkill.mockReset()
	mockModule.upsertSkillVector.mockReset()
	mockModule.prepareSkillPersistence.mockReset()
	mockModule.buildSkillEmbedTextFromStoredRow.mockReset()

	mockModule.getMcpSkillByName.mockResolvedValue(null)
	mockModule.prepareSkillPersistence.mockResolvedValue({
		rowPayload: {
			name: 'deploy-worker',
			title: 'Deploy Worker',
			description: 'Deploys the worker',
			collection_name: null,
			collection_slug: null,
			keywords: '["deploy"]',
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
		embedText: 'Deploy Worker\nDeploys the worker',
		merged: [],
		inferencePartial: false,
		derived: {
			destructiveDerived: false,
			readOnlyDerived: true,
			idempotentDerived: true,
		},
		warnings: [],
	})
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
			source_id: null,
			name: 'deploy-worker',
		}),
	)
})

test('meta_save_skill refuses to update repo-backed skills when repo source support is unavailable', async () => {
	mockModule.getMcpSkillByName.mockReset()
	mockModule.insertMcpSkill.mockReset()
	mockModule.updateMcpSkill.mockReset()
	mockModule.deleteMcpSkill.mockReset()
	mockModule.upsertSkillVector.mockReset()
	mockModule.prepareSkillPersistence.mockReset()
	mockModule.buildSkillEmbedTextFromStoredRow.mockReset()

	mockModule.prepareSkillPersistence.mockResolvedValue({
		rowPayload: {
			name: 'deploy-worker',
			title: 'Deploy Worker',
			description: 'Deploys the worker',
			collection_name: null,
			collection_slug: null,
			keywords: '["deploy"]',
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
		embedText: 'Deploy Worker\nDeploys the worker',
		merged: [],
		inferencePartial: false,
		derived: {
			destructiveDerived: false,
			readOnlyDerived: true,
			idempotentDerived: true,
		},
		warnings: [],
	})
	mockModule.getMcpSkillByName.mockResolvedValue({
		id: 'skill-1',
		user_id: 'user-1',
		name: 'deploy-worker',
		title: 'Deploy Worker',
		description: 'Deploys the worker',
		collection_name: null,
		collection_slug: null,
		source_id: 'source-1',
		keywords: '["deploy"]',
		code: 'async () => ({ ok: true })',
		search_text: null,
		uses_capabilities: null,
		parameters: null,
		inferred_capabilities: '[]',
		inference_partial: 0,
		read_only: 1,
		idempotent: 1,
		destructive: 0,
		created_at: '2026-04-17T00:00:00.000Z',
		updated_at: '2026-04-17T00:00:00.000Z',
	})

	await expect(
		metaSaveSkillCapability.handler(
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
		),
	).rejects.toThrow(
		'Repo-backed source support is unavailable in this environment. Missing required bindings: APP_DB, ARTIFACTS, REPO_SESSION.',
	)
	expect(mockModule.updateMcpSkill).not.toHaveBeenCalled()
})
