import { expect, test, vi } from 'vitest'
import { createMcpCallerContext } from '#mcp/context.ts'

const mockModule = vi.hoisted(() => ({
	getMcpSkillByNameInput: vi.fn(),
	repoSessionRpc: vi.fn(),
	runCodemodeWithRegistry: vi.fn(),
}))

vi.mock('#mcp/skills/mcp-skills-repo.ts', () => ({
	getMcpSkillByNameInput: (...args: Array<unknown>) =>
		mockModule.getMcpSkillByNameInput(...args),
}))

vi.mock('#worker/repo/repo-session-do.ts', () => ({
	repoSessionRpc: (...args: Array<unknown>) => mockModule.repoSessionRpc(...args),
}))

vi.mock('#mcp/run-codemode-registry.ts', () => ({
	runCodemodeWithRegistry: (...args: Array<unknown>) =>
		mockModule.runCodemodeWithRegistry(...args),
}))

const { runSavedSkill } = await import('./run-saved-skill.ts')

test('runSavedSkill opens a repo session and executes repo-backed skill code immediately after save', async () => {
	mockModule.getMcpSkillByNameInput.mockReset()
	mockModule.repoSessionRpc.mockReset()
	mockModule.runCodemodeWithRegistry.mockReset()

	mockModule.getMcpSkillByNameInput.mockResolvedValue({
		id: 'skill-1',
		user_id: 'user-1',
		name: 'fresh-skill',
		title: 'Fresh skill',
		description: 'Runs from repo',
		collection_name: null,
		collection_slug: null,
		source_id: 'source-1',
		keywords: '[]',
		code: 'async () => ({ inline: false })',
		search_text: null,
		uses_capabilities: null,
		parameters: null,
		inferred_capabilities: '[]',
		inference_partial: 0,
		read_only: 1,
		idempotent: 1,
		destructive: 0,
		created_at: '2026-04-18T00:00:00.000Z',
		updated_at: '2026-04-18T00:00:00.000Z',
	})

	const sessionClient = {
		openSession: vi.fn(async () => ({
			id: 'skill-runtime-skill-1-session',
			source_id: 'source-1',
			source_root: '/',
			base_commit: 'commit-1',
			session_repo_id: 'session-repo-1',
			session_repo_name: 'session-repo-name',
			session_repo_namespace: 'default',
			conversation_id: null,
			last_checkpoint_commit: null,
			last_check_run_id: null,
			last_check_tree_hash: null,
			expires_at: null,
			created_at: '2026-04-18T00:00:00.000Z',
			updated_at: '2026-04-18T00:00:00.000Z',
			published_commit: 'commit-1',
			manifest_path: 'kody.json',
			entity_type: 'skill' as const,
		})),
		readFile: vi.fn(
			async (input: {
				sessionId: string
				userId: string
				path: string
			}) => {
				expect(input).toEqual(
					expect.objectContaining({
						sessionId: 'skill-runtime-skill-1-session',
						userId: 'user-1',
						path: expect.any(String),
					}),
				)
				if (input.path === 'kody.json') {
					return {
						path: input.path,
						content: JSON.stringify({
							version: 1,
							kind: 'skill',
							title: 'Fresh skill',
							description: 'Runs from repo',
							entrypoint: 'skill.ts',
						}),
					}
				}
				if (input.path === 'skill.ts') {
					return {
						path: input.path,
						content: 'async () => ({ ok: true, repoBacked: true })',
					}
				}
				throw new Error(`Unexpected repo session readFile path: ${input.path}`)
			},
		),
		discardSession: vi.fn(async () => ({
			ok: true as const,
			sessionId: 'skill-runtime-skill-1-session',
			deleted: true,
		})),
	}
	mockModule.repoSessionRpc.mockReturnValue(sessionClient)
	mockModule.runCodemodeWithRegistry.mockResolvedValue({
		result: { ok: true, repoBacked: true },
		logs: ['repo-backed skill executed'],
	})

	const callerContext = createMcpCallerContext({
		baseUrl: 'https://heykody.dev',
		user: { userId: 'user-1', email: 'user@example.com' },
	})

	const result = await runSavedSkill({
		env: {} as Env,
		callerContext,
		name: 'fresh-skill',
	})

	expect(result).toEqual({
		ok: true,
		result: { ok: true, repoBacked: true },
		logs: ['repo-backed skill executed'],
	})
	expect(sessionClient.openSession).toHaveBeenCalledWith({
		sessionId: expect.stringMatching(/^skill-runtime-skill-1-/),
		sourceId: 'source-1',
		userId: 'user-1',
		baseUrl: 'https://heykody.dev',
		sourceRoot: '/',
	})
	expect(mockModule.runCodemodeWithRegistry).toHaveBeenCalledWith(
		{} as Env,
		expect.objectContaining({
			repoContext: expect.objectContaining({
				sourceId: 'source-1',
				sessionId: 'skill-runtime-skill-1-session',
				publishedCommit: 'commit-1',
				entityKind: 'skill',
				entityId: 'skill-1',
			}),
		}),
		'async () => ({ ok: true, repoBacked: true })',
		undefined,
		expect.objectContaining({
			executorExports: expect.any(Object),
		}),
	)
	expect(sessionClient.discardSession).toHaveBeenCalledWith({
		sessionId: 'skill-runtime-skill-1-session',
		userId: 'user-1',
	})
})
