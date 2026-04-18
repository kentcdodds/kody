import { expect, test, vi } from 'vitest'
import { createMcpCallerContext } from '#mcp/context.ts'

const mockModule = vi.hoisted(() => ({
	getMcpSkillByNameInput: vi.fn(),
	repoSessionRpc: vi.fn(),
	runCodemodeWithRegistry: vi.fn(),
	buildRepoCodemodeBundle: vi.fn(),
	loadRepoSourceFilesFromSession: vi.fn(),
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

vi.mock('#worker/repo/repo-codemode-execution.ts', () => ({
	buildRepoCodemodeBundle: (...args: Array<unknown>) =>
		mockModule.buildRepoCodemodeBundle(...args),
	loadRepoSourceFilesFromSession: (...args: Array<unknown>) =>
		mockModule.loadRepoSourceFilesFromSession(...args),
	getRepoSourceRelativePath: (path: string, sourceRoot: string) => {
		const normalizedPath = path.replace(/^\/+/, '')
		const normalizedSourceRoot = sourceRoot.replace(/^\/+/, '').replace(/\/+$/, '')
		if (!normalizedSourceRoot) return normalizedPath
		if (normalizedPath === normalizedSourceRoot) return ''
		return normalizedPath.startsWith(`${normalizedSourceRoot}/`)
			? normalizedPath.slice(normalizedSourceRoot.length + 1)
			: normalizedPath
	},
	createRepoCodemodeWrapper: ({
		mainModule,
		includeStorage,
	}: {
		mainModule: string
		includeStorage?: boolean
	}) => `repo-wrapper:${mainModule}:${includeStorage === true ? 'storage' : 'no-storage'}`,
}))

const { runSavedSkill } = await import('./run-saved-skill.ts')

test('runSavedSkill opens a repo session and executes repo-backed skill code immediately after save', async () => {
	mockModule.getMcpSkillByNameInput.mockReset()
	mockModule.repoSessionRpc.mockReset()
	mockModule.runCodemodeWithRegistry.mockReset()
	mockModule.buildRepoCodemodeBundle.mockReset()
	mockModule.loadRepoSourceFilesFromSession.mockReset()

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
	mockModule.loadRepoSourceFilesFromSession.mockResolvedValue({
		'skill.ts': 'export default async () => ({ ok: true, repoBacked: true })',
		'util.ts': 'export const ok = true',
	})
	mockModule.buildRepoCodemodeBundle.mockResolvedValue({
		entrypointMode: 'module',
		mainModule: 'dist/entry.js',
		modules: {
			'dist/entry.js': 'export default async () => ({ ok: true, repoBacked: true })',
		},
	})
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
		'repo-wrapper:dist/entry.js:no-storage',
		undefined,
		expect.objectContaining({
			executorExports: expect.any(Object),
			executorModules: {
				'dist/entry.js':
					'export default async () => ({ ok: true, repoBacked: true })',
			},
		}),
	)
	expect(mockModule.buildRepoCodemodeBundle).toHaveBeenCalledWith({
		sourceFiles: {
			'skill.ts': 'export default async () => ({ ok: true, repoBacked: true })',
			'util.ts': 'export const ok = true',
		},
		entryPoint: 'skill.ts',
		entryPointSource: 'async () => ({ ok: true, repoBacked: true })',
		sourceRoot: '/',
		cacheKey: 'source-1:commit-1',
	})
	expect(sessionClient.discardSession).toHaveBeenCalledWith({
		sessionId: 'skill-runtime-skill-1-session',
		userId: 'user-1',
	})
})

test('runSavedSkill bundles repo-backed skills relative to manifest sourceRoot', async () => {
	mockModule.getMcpSkillByNameInput.mockReset()
	mockModule.repoSessionRpc.mockReset()
	mockModule.runCodemodeWithRegistry.mockReset()
	mockModule.buildRepoCodemodeBundle.mockReset()
	mockModule.loadRepoSourceFilesFromSession.mockReset()

	mockModule.getMcpSkillByNameInput.mockResolvedValue({
		id: 'skill-2',
		user_id: 'user-1',
		name: 'nested-skill',
		title: 'Nested skill',
		description: 'Runs from nested repo root',
		collection_name: null,
		collection_slug: null,
		source_id: 'source-2',
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
			id: 'skill-runtime-skill-2-session',
			source_id: 'source-2',
			source_root: '/',
			base_commit: 'commit-2',
			session_repo_id: 'session-repo-2',
			session_repo_name: 'session-repo-name',
			session_repo_namespace: 'default',
			conversation_id: null,
			last_checkpoint_commit: null,
			last_check_run_id: null,
			last_check_tree_hash: null,
			expires_at: null,
			created_at: '2026-04-18T00:00:00.000Z',
			updated_at: '2026-04-18T00:00:00.000Z',
			published_commit: 'commit-2',
			manifest_path: 'kody.json',
			entity_type: 'skill' as const,
		})),
		readFile: vi.fn(async ({ path }: { path: string }) => ({
			path,
			content:
				path === 'kody.json'
					? JSON.stringify({
							version: 1,
							kind: 'skill',
							title: 'Nested skill',
							description: 'Runs from nested repo root',
							sourceRoot: '/src',
							entrypoint: 'src/skill.ts',
						})
					: 'export default async () => ({ ok: true, nested: true })',
		})),
		discardSession: vi.fn(async () => ({
			ok: true as const,
			sessionId: 'skill-runtime-skill-2-session',
			deleted: true,
		})),
	}
	mockModule.repoSessionRpc.mockReturnValue(sessionClient)
	mockModule.loadRepoSourceFilesFromSession.mockResolvedValue({
		'skill.ts': 'export default async () => ({ ok: true, nested: true })',
		'helper.ts': 'export const value = 1',
	})
	mockModule.buildRepoCodemodeBundle.mockResolvedValue({
		entrypointMode: 'module',
		mainModule: 'dist/nested-entry.js',
		modules: {
			'dist/nested-entry.js':
				'export default async () => ({ ok: true, nested: true })',
		},
	})
	mockModule.runCodemodeWithRegistry.mockResolvedValue({
		result: { ok: true, nested: true },
		logs: ['repo-backed nested skill executed'],
	})

	const callerContext = createMcpCallerContext({
		baseUrl: 'https://heykody.dev',
		user: { userId: 'user-1', email: 'user@example.com' },
	})

	const result = await runSavedSkill({
		env: {} as Env,
		callerContext,
		name: 'nested-skill',
	})

	expect(result).toEqual({
		ok: true,
		result: { ok: true, nested: true },
		logs: ['repo-backed nested skill executed'],
	})
	expect(mockModule.loadRepoSourceFilesFromSession).toHaveBeenCalledWith({
		sessionClient,
		sessionId: 'skill-runtime-skill-2-session',
		userId: 'user-1',
		sourceRoot: '/src',
	})
	expect(mockModule.buildRepoCodemodeBundle).toHaveBeenCalledWith({
		sourceFiles: {
			'skill.ts': 'export default async () => ({ ok: true, nested: true })',
			'helper.ts': 'export const value = 1',
		},
		sourceRoot: '/src',
		entryPoint: 'skill.ts',
		entryPointSource: 'export default async () => ({ ok: true, nested: true })',
		cacheKey: 'source-2:commit-2',
	})
	expect(mockModule.runCodemodeWithRegistry).toHaveBeenCalledWith(
		{} as Env,
		expect.objectContaining({
			repoContext: expect.objectContaining({
				sourceId: 'source-2',
				sessionId: 'skill-runtime-skill-2-session',
			}),
		}),
		'repo-wrapper:dist/nested-entry.js:no-storage',
		undefined,
		expect.objectContaining({
			executorModules: {
				'dist/nested-entry.js':
					'export default async () => ({ ok: true, nested: true })',
			},
		}),
	)
	expect(sessionClient.discardSession).toHaveBeenCalledWith({
		sessionId: 'skill-runtime-skill-2-session',
		userId: 'user-1',
	})
})
