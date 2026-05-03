import { expect, test, vi } from 'vitest'
import { createMcpCallerContext } from '#mcp/context.ts'
import { type getSavedPackageById } from '#worker/package-registry/repo.ts'
import type * as ArtifactsModule from '#worker/repo/artifacts.ts'
import { type resolveSessionRepo } from '#worker/repo/artifacts.ts'

const mockModule = vi.hoisted(() => ({
	getActiveRepoSessionByConversation: vi.fn(),
	getEntitySourceById: vi.fn(),
	getSavedPackageByKodyId: vi.fn(),
	getSavedPackageById: vi.fn<
		Parameters<typeof getSavedPackageById>,
		ReturnType<typeof getSavedPackageById>
	>(),
	repoSessionRpc: vi.fn(),
	getSandbox: vi.fn(),
	resolveSessionRepo: vi.fn<
		Parameters<typeof resolveSessionRepo>,
		ReturnType<typeof resolveSessionRepo>
	>(),
}))

vi.mock('#worker/repo/repo-sessions.ts', () => ({
	getActiveRepoSessionByConversation: (...args: Array<unknown>) =>
		mockModule.getActiveRepoSessionByConversation(...args),
}))

vi.mock('#worker/repo/entity-sources.ts', () => ({
	getEntitySourceById: (...args: Array<unknown>) =>
		mockModule.getEntitySourceById(...args),
}))

vi.mock('#worker/package-registry/repo.ts', () => ({
	getSavedPackageById: (...args: Array<unknown>) =>
		mockModule.getSavedPackageById(...args),
	getSavedPackageByKodyId: (...args: Array<unknown>) =>
		mockModule.getSavedPackageByKodyId(...args),
}))

vi.mock('#worker/repo/repo-session-do.ts', () => ({
	repoSessionRpc: (...args: Array<unknown>) =>
		mockModule.repoSessionRpc(...args),
}))

vi.mock('#worker/repo/artifacts.ts', async () => {
	const actual = await vi.importActual<typeof ArtifactsModule>(
		'#worker/repo/artifacts.ts',
	)
	return {
		...actual,
		resolveSessionRepo: (...args: Array<unknown>) =>
			mockModule.resolveSessionRepo(...args),
	}
})

vi.mock('@cloudflare/sandbox', () => ({
	getSandbox: (...args: Array<unknown>) => mockModule.getSandbox(...args),
}))

const { packageShellOpenCapability } = await import('./package-shell-open.ts')
const { packageShellExecCapability } = await import('./package-shell-exec.ts')

function createCapabilityContext() {
	return {
		env: {
			APP_DB: {},
			Sandbox: {},
		} as Env,
		callerContext: createMcpCallerContext({
			baseUrl: 'https://heykody.dev',
			user: {
				userId: 'user-1',
				email: 'user@example.com',
				displayName: 'User One',
			},
		}),
	}
}

function createPackageSourceRow() {
	return {
		id: 'source-package-1',
		user_id: 'user-1',
		entity_kind: 'package',
		entity_id: 'package-1',
		repo_id: 'repo-package-1',
		published_commit: 'commit-package-1',
		indexed_commit: 'commit-package-1',
		manifest_path: 'package.json',
		source_root: '/',
		created_at: '2026-04-18T00:00:00.000Z',
		updated_at: '2026-04-18T00:00:00.000Z',
	}
}

function createSessionInfo() {
	return {
		id: 'session-1',
		source_id: 'source-package-1',
		source_root: '/',
		base_commit: 'commit-package-1',
		session_repo_id: 'session-repo-1',
		session_repo_name: 'repo-package-1-session-1',
		session_repo_namespace: 'default',
		conversation_id: null,
		last_checkpoint_commit: 'commit-package-1',
		last_check_run_id: null,
		last_check_tree_hash: null,
		expires_at: null,
		created_at: '2026-04-18T00:01:00.000Z',
		updated_at: '2026-04-18T00:01:00.000Z',
		published_commit: 'commit-package-1',
		manifest_path: 'package.json',
		entity_type: 'package',
	}
}

function setupPackageShellMocks() {
	mockModule.getActiveRepoSessionByConversation.mockReset()
	mockModule.getEntitySourceById.mockReset()
	mockModule.getSavedPackageByKodyId.mockReset()
	mockModule.getSavedPackageById.mockReset()
	mockModule.repoSessionRpc.mockReset()
	mockModule.getSandbox.mockReset()
	mockModule.resolveSessionRepo.mockReset()
	mockModule.getActiveRepoSessionByConversation.mockResolvedValue(null)
	mockModule.getSavedPackageByKodyId.mockResolvedValue({
		id: 'package-1',
		userId: 'user-1',
		name: '@kody/example-package',
		kodyId: 'example-package',
		description: 'Example package',
		tags: [],
		searchText: null,
		sourceId: 'source-package-1',
		hasApp: false,
		createdAt: '2026-04-18T00:00:00.000Z',
		updatedAt: '2026-04-18T00:00:00.000Z',
	})
	mockModule.getSavedPackageById.mockResolvedValue({
		id: 'package-1',
		userId: 'user-1',
		name: '@kody/example-package',
		kodyId: 'example-package',
		description: 'Example package',
		tags: [],
		searchText: null,
		sourceId: 'source-package-1',
		hasApp: false,
		createdAt: '2026-04-18T00:00:00.000Z',
		updatedAt: '2026-04-18T00:00:00.000Z',
	})
	mockModule.getEntitySourceById.mockResolvedValue(createPackageSourceRow())
	const rpc = {
		openSession: vi.fn(async () => createSessionInfo()),
		getSessionInfo: vi.fn(async () => createSessionInfo()),
		syncSessionFromRemote: vi.fn(async () => ({
			ok: true as const,
			sessionId: 'session-1',
			headCommit: 'commit-shell',
			changed: true,
		})),
	}
	mockModule.repoSessionRpc.mockReturnValue(rpc)
	mockModule.resolveSessionRepo.mockResolvedValue({
		info: vi.fn(async () => ({
			remote:
				'https://acct.artifacts.cloudflare.net/git/default/repo-package-1-session-1.git',
			defaultBranch: 'main',
		})),
		createToken: vi.fn(async () => ({
			plaintext: 'art_session_secret?expires=1760000200',
			expiresAt: '2025-10-09T08:56:40.000Z',
		})),
	})
	const executionSession = {
		exec: vi.fn(async (command: string) => ({
			command,
			success: true,
			exitCode: 0,
			stdout: 'ok',
			stderr: '',
			duration: 12,
			timestamp: '2026-04-18T00:02:00.000Z',
		})),
	}
	const sandbox = {
		setEnvVars: vi.fn(async () => undefined),
		createSession: vi.fn(async () => executionSession),
	}
	mockModule.getSandbox.mockReturnValue(sandbox)
	return { rpc, sandbox, executionSession }
}

test('package_shell_open opens a package session and returns shell instructions without credentials in the remote', async () => {
	const { sandbox } = setupPackageShellMocks()

	const result = await packageShellOpenCapability.handler(
		{
			target: { kind: 'package', kody_id: 'example-package' },
		},
		createCapabilityContext(),
	)

	expect(result).toEqual(
		expect.objectContaining({
			session_id: 'session-1',
			package_dir: '/workspace/package',
			remote:
				'https://acct.artifacts.cloudflare.net/git/default/repo-package-1-session-1.git',
			default_branch: 'main',
		}),
	)
	expect(result.remote).not.toContain('art_session_secret')
	expect(result.instructions.join('\n')).toContain('package_check')
	expect(sandbox.setEnvVars).toHaveBeenCalledWith(
		expect.objectContaining({
			KODY_PACKAGE_REMOTE:
				'https://x:art_session_secret@acct.artifacts.cloudflare.net/git/default/repo-package-1-session-1.git',
			KODY_PACKAGE_DIR: '/workspace/package',
		}),
	)
})

test('package_shell_exec runs the command as-is and syncs the repo session after shell changes', async () => {
	const { executionSession, rpc } = setupPackageShellMocks()

	const result = await packageShellExecCapability.handler(
		{
			session_id: 'session-1',
			command: 'cd "$KODY_PACKAGE_DIR" && npm test && git push',
			cwd: '/workspace/package',
		},
		createCapabilityContext(),
	)

	expect(executionSession.exec).toHaveBeenCalledWith(
		'cd "$KODY_PACKAGE_DIR" && npm test && git push',
		expect.objectContaining({ cwd: '/workspace/package' }),
	)
	expect(rpc.syncSessionFromRemote).toHaveBeenCalledWith({
		sessionId: 'session-1',
		userId: 'user-1',
	})
	expect(result).toEqual(
		expect.objectContaining({
			success: true,
			exit_code: 0,
			resolved_target: {
				kind: 'package',
				source_id: 'source-package-1',
				package_id: 'package-1',
				kody_id: 'example-package',
				name: '@kody/example-package',
			},
			stdout: 'ok',
			synced_session: {
				ok: true,
				session_id: 'session-1',
				head_commit: 'commit-shell',
				changed: true,
			},
		}),
	)
})
