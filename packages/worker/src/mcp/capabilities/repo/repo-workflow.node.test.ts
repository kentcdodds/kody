import { expect, test, vi } from 'vitest'
import { createMcpCallerContext } from '#mcp/context.ts'

const mockModule = vi.hoisted(() => ({
	getActiveRepoSessionByConversation: vi.fn(),
	getEntitySourceById: vi.fn(),
	getSavedPackageById: vi.fn(),
	getSavedPackageByKodyId: vi.fn(),
	repoSessionRpc: vi.fn(),
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

const { repoOpenSessionCapability } = await import('./repo-open-session.ts')
const { repoPublishSessionCapability } =
	await import('./repo-publish-session.ts')
const { repoRunCommandsCapability } = await import('./repo-run-commands.ts')

function createCapabilityContext() {
	return {
		env: {
			APP_DB: {
				prepare() {
					return {
						bind() {
							return {
								first: async () => ({ username: 'user' }),
							}
						},
					}
				},
			},
		} as unknown as Env,
		callerContext: createMcpCallerContext({
			baseUrl: 'https://heykody.dev',
			user: {
				userId: 'user-1',
				email: 'user@example.com',
				displayName: 'user',
			},
		}),
	}
}

function createRepoRpc(overrides?: Partial<Record<string, unknown>>) {
	return {
		openSession: vi.fn(),
		getSessionInfo: vi.fn(),
		runCommands: vi.fn(),
		runChecks: vi.fn(),
		publishSession: vi.fn(),
		listPublishedPackageArtifactTargets: vi.fn(async () => []),
		rebuildPublishedPackageArtifact: vi.fn(),
		...overrides,
	}
}

function resetMocks() {
	mockModule.getActiveRepoSessionByConversation.mockReset()
	mockModule.getEntitySourceById.mockReset()
	mockModule.getSavedPackageById.mockReset()
	mockModule.getSavedPackageByKodyId.mockReset()
	mockModule.repoSessionRpc.mockReset()
}

function createSavedPackageRow() {
	return {
		id: 'package-1',
		userId: 'user-1',
		name: '@kody/triage-github-pr',
		kodyId: 'triage-github-pr',
		description: 'Triages one PR',
		tags: ['github', 'triage'],
		searchText: null,
		sourceId: 'source-package-1',
		hasApp: false,
		hidden: false,
		createdAt: '2026-04-18T00:00:00.000Z',
		updatedAt: '2026-04-18T00:00:00.000Z',
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

test('repo open → run commands → publish session workflow', async () => {
	resetMocks()
	mockModule.getActiveRepoSessionByConversation.mockResolvedValueOnce(null)
	mockModule.getSavedPackageByKodyId.mockResolvedValueOnce(
		createSavedPackageRow(),
	)
	mockModule.getEntitySourceById.mockResolvedValueOnce(createPackageSourceRow())
	const openRpc = createRepoRpc()
	openRpc.openSession.mockResolvedValueOnce({
		id: 'session-1',
		source_id: 'source-package-1',
		source_root: '/',
		base_commit: 'commit-package-1',
		session_branch: 'sessions/session-1',
		source_branch: 'main',
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
	})
	mockModule.repoSessionRpc.mockReturnValue(openRpc)

	const opened = await repoOpenSessionCapability.handler(
		{
			target: { kind: 'package', kody_id: 'triage-github-pr' },
		},
		createCapabilityContext(),
	)

	expect(opened.resolved_target).toEqual({
		kind: 'package',
		source_id: 'source-package-1',
		package_id: 'package-1',
		kody_id: 'triage-github-pr',
		name: '@kody/triage-github-pr',
	})
	expect(openRpc.openSession).toHaveBeenCalledWith(
		expect.objectContaining({
			sourceId: 'source-package-1',
			userId: 'user-1',
			sourceRoot: '/',
		}),
	)

	resetMocks()
	mockModule.getActiveRepoSessionByConversation.mockResolvedValueOnce({
		id: 'session-other',
		source_id: 'source-other',
	})
	mockModule.getSavedPackageByKodyId.mockResolvedValueOnce(
		createSavedPackageRow(),
	)
	mockModule.getEntitySourceById.mockResolvedValueOnce({
		...createPackageSourceRow(),
		id: 'source-other',
		entity_id: 'package-other',
	})

	await expect(
		repoOpenSessionCapability.handler(
			{
				target: { kind: 'package', kody_id: 'triage-github-pr' },
				conversation_id: 'conversation-1',
			},
			createCapabilityContext(),
		),
	).rejects.toThrow()

	resetMocks()
	await expect(
		repoRunCommandsCapability.handler(
			{
				target: { kind: 'package', kody_id: 'triage-github-pr' },
				conversation_id: 'conversation-1',
				commands: 'git status',
			},
			createCapabilityContext(),
		),
	).rejects.toThrow()
	expect(mockModule.repoSessionRpc).not.toHaveBeenCalled()

	resetMocks()
	mockModule.getSavedPackageById
		.mockResolvedValueOnce(createSavedPackageRow())
		.mockResolvedValueOnce(createSavedPackageRow())
	mockModule.getEntitySourceById
		.mockResolvedValueOnce(createPackageSourceRow())
		.mockResolvedValueOnce(createPackageSourceRow())
	const resumeRpc = createRepoRpc()
	resumeRpc.getSessionInfo.mockResolvedValueOnce({
		id: 'session-existing',
		source_id: 'source-package-1',
		source_root: '/',
		base_commit: 'commit-package-1',
		session_branch: 'sessions/session-1',
		source_branch: 'main',
		conversation_id: 'conversation-1',
		last_checkpoint_commit: 'commit-package-1',
		last_check_run_id: null,
		last_check_tree_hash: null,
		expires_at: null,
		created_at: '2026-04-18T00:01:00.000Z',
		updated_at: '2026-04-18T00:02:00.000Z',
		published_commit: 'commit-package-1',
		manifest_path: 'package.json',
		entity_type: 'package',
	})
	resumeRpc.getSessionInfo.mockResolvedValueOnce({
		id: 'session-existing',
		source_id: 'source-package-1',
		source_root: '/',
		base_commit: 'commit-package-1',
		session_branch: 'sessions/session-1',
		source_branch: 'main',
		conversation_id: 'conversation-1',
		last_checkpoint_commit: 'commit-package-1',
		last_check_run_id: null,
		last_check_tree_hash: null,
		expires_at: null,
		created_at: '2026-04-18T00:01:00.000Z',
		updated_at: '2026-04-18T00:02:00.000Z',
		published_commit: 'commit-package-1',
		manifest_path: 'package.json',
		entity_type: 'package',
	})
	resumeRpc.runCommands.mockResolvedValueOnce({
		session: {
			id: 'session-existing',
			source_id: 'source-package-1',
			source_root: '/',
			base_commit: 'commit-package-1',
			session_branch: 'sessions/session-1',
			source_branch: 'main',
			conversation_id: 'conversation-1',
			last_checkpoint_commit: 'commit-package-1',
			last_check_run_id: null,
			last_check_tree_hash: null,
			expires_at: null,
			created_at: '2026-04-18T00:01:00.000Z',
			updated_at: '2026-04-18T00:02:00.000Z',
			published_commit: 'commit-package-1',
			manifest_path: 'package.json',
			entity_type: 'package',
		},
		commands: [{ line: 1, command: 'git status', ok: true, output: [] }],
		checks: { status: 'not_requested' },
		publish: { status: 'not_requested' },
	})
	mockModule.repoSessionRpc.mockReturnValue(resumeRpc)

	const resumed = await repoRunCommandsCapability.handler(
		{
			session_id: 'session-existing',
			commands: 'git status',
			run_checks: false,
			publish: false,
		},
		createCapabilityContext(),
	)

	expect(resumeRpc.runCommands).toHaveBeenCalledWith({
		sessionId: 'session-existing',
		userId: 'user-1',
		commands: 'git status',
		dryRun: undefined,
		runChecks: false,
		publish: false,
		expectedPackageScope: undefined,
	})
	expect(resumed.commands).toEqual([
		{ line: 1, command: 'git status', ok: true, output: [] },
	])
	expect(resumed.resolved_target).toEqual({
		kind: 'package',
		source_id: 'source-package-1',
		package_id: 'package-1',
		kody_id: 'triage-github-pr',
		name: '@kody/triage-github-pr',
	})

	resetMocks()
	mockModule.getActiveRepoSessionByConversation.mockResolvedValueOnce(null)
	mockModule.getSavedPackageByKodyId.mockResolvedValueOnce(
		createSavedPackageRow(),
	)
	mockModule.getSavedPackageById.mockResolvedValueOnce(createSavedPackageRow())
	mockModule.getEntitySourceById
		.mockResolvedValueOnce(createPackageSourceRow())
		.mockResolvedValueOnce(createPackageSourceRow())
	const failedChecksRpc = createRepoRpc()
	failedChecksRpc.openSession.mockResolvedValueOnce({
		id: 'session-1',
		source_id: 'source-package-1',
		source_root: '/',
		base_commit: 'commit-package-1',
		session_branch: 'sessions/session-1',
		source_branch: 'main',
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
	})
	failedChecksRpc.runCommands.mockResolvedValueOnce({
		session: {
			id: 'session-1',
			source_id: 'source-package-1',
			source_root: '/',
			base_commit: 'commit-package-1',
			session_branch: 'sessions/session-1',
			source_branch: 'main',
			conversation_id: null,
			last_checkpoint_commit: 'commit-package-1',
			last_check_run_id: 'check-1',
			last_check_tree_hash: 'tree-1',
			expires_at: null,
			created_at: '2026-04-18T00:01:00.000Z',
			updated_at: '2026-04-18T00:02:00.000Z',
			published_commit: 'commit-package-1',
			manifest_path: 'package.json',
			entity_type: 'package',
		},
		commands: [
			{ line: 1, command: "git apply <<'PATCH'", ok: true, output: {} },
		],
		checks: {
			status: 'failed',
			ok: false,
			results: [
				{ kind: 'typecheck', ok: false, message: 'Typecheck failed' },
				{ kind: 'manifest', ok: true, message: 'Manifest ok' },
			],
			failedChecks: [
				{ kind: 'typecheck', ok: false, message: 'Typecheck failed' },
			],
			manifest: {
				name: '@kody/triage-github-pr',
				kody: {
					id: 'triage-github-pr',
					description: 'Triages one PR',
				},
			},
			runId: 'check-1',
			treeHash: 'tree-1',
			checkedAt: '2026-04-18T00:02:00.000Z',
		},
		publish: {
			status: 'blocked_by_checks',
			message: 'Publishing skipped because repo checks failed.',
		},
	})
	mockModule.repoSessionRpc.mockReturnValue(failedChecksRpc)

	const commands = [
		"git apply <<'PATCH'",
		'--- a/src/index.ts',
		'+++ b/src/index.ts',
		'PATCH',
	].join('\n')
	const failedChecks = await repoRunCommandsCapability.handler(
		{
			target: { kind: 'package', kody_id: 'triage-github-pr' },
			commands,
			run_checks: true,
			publish: true,
		},
		createCapabilityContext(),
	)

	expect(failedChecksRpc.runCommands).toHaveBeenCalledWith({
		sessionId: 'session-1',
		userId: 'user-1',
		commands,
		dryRun: undefined,
		runChecks: true,
		publish: false,
		expectedPackageScope: 'user',
	})
	expect(failedChecks.checks).toMatchObject({
		status: 'failed',
		ok: false,
		failed_checks: [{ kind: 'typecheck', ok: false }],
		manifest: {
			name: '@kody/triage-github-pr',
			kody_id: 'triage-github-pr',
			has_app: false,
		},
		run_id: 'check-1',
		tree_hash: 'tree-1',
	})
	expect(failedChecks.publish).toMatchObject({
		status: 'blocked_by_checks',
		failed_checks: [{ kind: 'typecheck', ok: false }],
		run_id: 'check-1',
	})

	resetMocks()
	mockModule.getSavedPackageById
		.mockResolvedValueOnce(createSavedPackageRow())
		.mockResolvedValueOnce(createSavedPackageRow())
	mockModule.getEntitySourceById
		.mockResolvedValueOnce(createPackageSourceRow())
		.mockResolvedValueOnce(createPackageSourceRow())
	const publishRpc = createRepoRpc()
	publishRpc.getSessionInfo.mockResolvedValueOnce({
		id: 'session-existing',
		source_id: 'source-package-1',
		source_root: '/',
		base_commit: 'commit-package-1',
		session_branch: 'sessions/session-1',
		source_branch: 'main',
		conversation_id: 'conversation-1',
		last_checkpoint_commit: 'commit-package-1',
		last_check_run_id: null,
		last_check_tree_hash: null,
		expires_at: null,
		created_at: '2026-04-18T00:01:00.000Z',
		updated_at: '2026-04-18T00:02:00.000Z',
		published_commit: 'commit-package-1',
		manifest_path: 'package.json',
		entity_type: 'package',
	})
	publishRpc.getSessionInfo.mockResolvedValueOnce({
		id: 'session-existing',
		source_id: 'source-package-1',
		source_root: '/',
		base_commit: 'commit-package-1',
		session_branch: 'sessions/session-1',
		source_branch: 'main',
		conversation_id: 'conversation-1',
		last_checkpoint_commit: 'commit-package-1',
		last_check_run_id: null,
		last_check_tree_hash: null,
		expires_at: null,
		created_at: '2026-04-18T00:01:00.000Z',
		updated_at: '2026-04-18T00:02:00.000Z',
		published_commit: 'commit-package-1',
		manifest_path: 'package.json',
		entity_type: 'package',
	})
	publishRpc.runCommands.mockResolvedValueOnce({
		session: {
			id: 'session-existing',
			source_id: 'source-package-1',
			source_root: '/',
			base_commit: 'commit-package-1',
			session_branch: 'sessions/session-1',
			source_branch: 'main',
			conversation_id: 'conversation-1',
			last_checkpoint_commit: 'commit-package-1',
			last_check_run_id: 'check-1',
			last_check_tree_hash: 'tree-1',
			expires_at: null,
			created_at: '2026-04-18T00:01:00.000Z',
			updated_at: '2026-04-18T00:02:00.000Z',
			published_commit: 'commit-published',
			manifest_path: 'package.json',
			entity_type: 'package',
		},
		commands: [{ line: 1, command: 'git status', ok: true, output: [] }],
		checks: {
			status: 'passed',
			ok: true,
			results: [{ kind: 'manifest', ok: true, message: 'Manifest ok' }],
			manifest: {
				name: '@kody/triage-github-pr',
				kody: {
					id: 'triage-github-pr',
					description: 'Triages one PR',
				},
			},
			runId: 'check-1',
			treeHash: 'tree-1',
			checkedAt: '2026-04-18T00:02:00.000Z',
		},
		publish: { status: 'not_requested' },
	})
	publishRpc.publishSession.mockResolvedValueOnce({
		status: 'ok',
		sessionId: 'session-existing',
		publishedCommit: 'commit-published',
		message: 'Published session.',
	})
	publishRpc.listPublishedPackageArtifactTargets.mockResolvedValueOnce([
		{
			kind: 'module',
			artifactName: '.',
			entryPoint: 'src/index.ts',
			bundleKind: 'module',
		},
		{
			kind: 'importable-module',
			artifactName: '.',
			entryPoint: 'src/index.ts',
			bundleKind: 'importable-module',
		},
	])
	mockModule.repoSessionRpc.mockReturnValue(publishRpc)

	const published = await repoRunCommandsCapability.handler(
		{
			session_id: 'session-existing',
			commands: 'git status',
			run_checks: true,
			publish: true,
		},
		createCapabilityContext(),
	)

	expect(published.checks).toMatchObject({
		status: 'passed',
		ok: true,
		manifest: {
			name: '@kody/triage-github-pr',
			kody_id: 'triage-github-pr',
			has_app: false,
		},
		run_id: 'check-1',
	})
	expect(published.publish).toMatchObject({
		status: 'ok',
		session_id: 'session-existing',
		published_commit: 'commit-published',
	})
	expect(publishRpc.rebuildPublishedPackageArtifact).toHaveBeenCalledTimes(2)
})

test('repo_publish_session covers base_moved repair, artifact rebuild, legacy RPC compatibility, and rebuild failures', async () => {
	resetMocks()
	const baseMovedRpc = createRepoRpc()
	baseMovedRpc.getSessionInfo.mockResolvedValueOnce({
		id: 'session-1',
		source_id: 'source-package-1',
		source_root: '/',
		base_commit: 'commit-old',
		session_branch: 'sessions/session-1',
		source_branch: 'main',
		conversation_id: null,
		last_checkpoint_commit: 'commit-old',
		last_check_run_id: 'check-1',
		last_check_tree_hash: 'tree-1',
		expires_at: null,
		created_at: '2026-04-18T00:01:00.000Z',
		updated_at: '2026-04-18T00:02:00.000Z',
		published_commit: 'commit-old',
		manifest_path: 'package.json',
		entity_type: 'package',
	})
	baseMovedRpc.publishSession.mockResolvedValueOnce({
		status: 'base_moved',
		sessionId: 'session-1',
		publishedCommit: null,
		message:
			'The source repo has moved since this session opened. Rebase the session before publishing.',
		repairHint: 'repo_rebase_session',
		sessionBaseCommit: 'commit-old',
		currentPublishedCommit: 'commit-new',
	})
	mockModule.repoSessionRpc.mockReturnValue(baseMovedRpc)

	const baseMovedResult = await repoPublishSessionCapability.handler(
		{ session_id: 'session-1' },
		createCapabilityContext(),
	)
	expect(baseMovedResult).toMatchObject({
		status: 'base_moved',
		session_id: 'session-1',
		published_commit: null,
		repair_hint: 'repo_rebase_session',
		session_base_commit: 'commit-old',
		current_published_commit: 'commit-new',
	})

	resetMocks()
	const publishRpc = createRepoRpc()
	publishRpc.getSessionInfo.mockResolvedValueOnce({
		id: 'session-1',
		source_id: 'source-package-1',
		source_root: '/',
		base_commit: 'commit-old',
		session_branch: 'sessions/session-1',
		source_branch: 'main',
		conversation_id: null,
		last_checkpoint_commit: 'commit-old',
		last_check_run_id: 'check-1',
		last_check_tree_hash: 'tree-1',
		expires_at: null,
		created_at: '2026-04-18T00:01:00.000Z',
		updated_at: '2026-04-18T00:02:00.000Z',
		published_commit: 'commit-old',
		manifest_path: 'package.json',
		entity_type: 'package',
	})
	publishRpc.publishSession.mockResolvedValueOnce({
		status: 'ok',
		sessionId: 'session-1',
		publishedCommit: 'commit-new',
		message: 'Published session.',
	})
	publishRpc.listPublishedPackageArtifactTargets.mockResolvedValueOnce([
		{
			kind: 'module',
			artifactName: '.',
			entryPoint: 'src/index.ts',
			bundleKind: 'module',
		},
	])
	mockModule.repoSessionRpc.mockReturnValue(publishRpc)

	const publishResult = await repoPublishSessionCapability.handler(
		{ session_id: 'session-1' },
		createCapabilityContext(),
	)
	expect(publishResult).toMatchObject({
		status: 'ok',
		session_id: 'session-1',
		published_commit: 'commit-new',
	})
	expect(publishRpc.publishSession).toHaveBeenCalledWith({
		sessionId: 'session-1',
		userId: 'user-1',
		rebuildPackageArtifacts: false,
		expectedPackageScope: 'user',
		privateVisibilityChangeConfirmed: false,
	})
	expect(publishRpc.rebuildPublishedPackageArtifact).toHaveBeenCalledWith({
		sessionId: 'session-1',
		sourceId: 'source-package-1',
		userId: 'user-1',
		publishedCommit: 'commit-new',
		target: {
			kind: 'module',
			artifactName: '.',
			entryPoint: 'src/index.ts',
			bundleKind: 'module',
		},
		baseUrl: 'https://heykody.dev',
	})

	resetMocks()
	const legacyRpc = createRepoRpc()
	legacyRpc.getSessionInfo.mockResolvedValueOnce({
		id: 'session-1',
		source_id: 'source-package-1',
		source_root: '/',
		base_commit: 'commit-old',
		session_branch: 'sessions/session-1',
		source_branch: 'main',
		conversation_id: null,
		last_checkpoint_commit: 'commit-old',
		last_check_run_id: 'check-1',
		last_check_tree_hash: 'tree-1',
		expires_at: null,
		created_at: '2026-04-18T00:01:00.000Z',
		updated_at: '2026-04-18T00:02:00.000Z',
		published_commit: 'commit-old',
		manifest_path: 'package.json',
		entity_type: 'package',
	})
	legacyRpc.publishSession.mockResolvedValueOnce({
		status: 'ok',
		sessionId: 'session-1',
		publishedCommit: 'commit-new',
		message: 'Published session.',
	})
	legacyRpc.listPublishedPackageArtifactTargets.mockRejectedValueOnce(
		new TypeError("Cannot read properties of undefined (reading 'bind')"),
	)
	mockModule.repoSessionRpc.mockReturnValue(legacyRpc)

	await expect(
		repoPublishSessionCapability.handler(
			{ session_id: 'session-1' },
			createCapabilityContext(),
		),
	).resolves.toMatchObject({
		status: 'ok',
		session_id: 'session-1',
		published_commit: 'commit-new',
	})
	expect(legacyRpc.rebuildPublishedPackageArtifact).not.toHaveBeenCalled()

	resetMocks()
	const rebuildFailureRpc = createRepoRpc()
	rebuildFailureRpc.getSessionInfo.mockResolvedValueOnce({
		id: 'session-1',
		source_id: 'source-package-1',
		source_root: '/',
		base_commit: 'commit-old',
		session_branch: 'sessions/session-1',
		source_branch: 'main',
		conversation_id: null,
		last_checkpoint_commit: 'commit-old',
		last_check_run_id: 'check-1',
		last_check_tree_hash: 'tree-1',
		expires_at: null,
		created_at: '2026-04-18T00:01:00.000Z',
		updated_at: '2026-04-18T00:02:00.000Z',
		published_commit: 'commit-old',
		manifest_path: 'package.json',
		entity_type: 'package',
	})
	rebuildFailureRpc.publishSession.mockResolvedValueOnce({
		status: 'ok',
		sessionId: 'session-1',
		publishedCommit: 'commit-new',
		message: 'Published session.',
	})
	rebuildFailureRpc.listPublishedPackageArtifactTargets.mockResolvedValueOnce([
		{
			kind: 'module',
			artifactName: '.',
			entryPoint: 'src/index.ts',
			bundleKind: 'module',
		},
	])
	rebuildFailureRpc.rebuildPublishedPackageArtifact.mockRejectedValueOnce(
		new Error('bundle too large'),
	)
	mockModule.repoSessionRpc.mockReturnValue(rebuildFailureRpc)

	await expect(
		repoPublishSessionCapability.handler(
			{ session_id: 'session-1' },
			createCapabilityContext(),
		),
	).rejects.toThrow(/bundle artifact rebuild failed/i)
})
