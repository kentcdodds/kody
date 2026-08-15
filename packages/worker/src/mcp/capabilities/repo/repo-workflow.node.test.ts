import { expect, test, vi } from 'vitest'
import { createMcpCallerContext } from '#mcp/context.ts'

const mockModule = vi.hoisted(() => ({
	getActiveRepoSessionByConversation: vi.fn(),
	countActiveRepoSessions: vi.fn(async () => 0),
	getEntitySourceByIdForUser: vi.fn(),
	getSavedPackageById: vi.fn(),
	getSavedPackageByKodyId: vi.fn(),
	repoSessionRpc: vi.fn(),
}))

vi.mock('#worker/repo/repo-sessions.ts', () => ({
	getActiveRepoSessionByConversation: (...args: Array<unknown>) =>
		mockModule.getActiveRepoSessionByConversation(...args),
	countActiveRepoSessions: (...args: Array<unknown>) =>
		mockModule.countActiveRepoSessions(...args),
}))

vi.mock('#worker/repo/entity-sources.ts', () => ({
	getEntitySourceByIdForUser: (...args: Array<unknown>) =>
		mockModule.getEntitySourceByIdForUser(...args),
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
const { repoEditFilesCapability } = await import('./repo-edit-files.ts')
const { repoCommitCapability } = await import('./repo-commit.ts')
const { repoRunChecksCapability } = await import('./repo-run-checks.ts')

function createCapabilityContext() {
	return {
		env: {
			APP_DB: {
				prepare() {
					return {
						bind() {
							return {
								first: async () => ({
									username: 'user',
									plan: 'max',
									stripe_plan: null,
								}),
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
		applyEdits: vi.fn(),
		sessionCommit: vi.fn(),
		runChecks: vi.fn(),
		publishSession: vi.fn(),
		listPublishedPackageArtifactTargets: vi.fn(async () => []),
		rebuildPublishedPackageArtifact: vi.fn(),
		...overrides,
	}
}

function resetMocks() {
	mockModule.getActiveRepoSessionByConversation.mockReset()
	mockModule.countActiveRepoSessions.mockReset()
	mockModule.countActiveRepoSessions.mockResolvedValue(0)
	mockModule.getEntitySourceByIdForUser.mockReset()
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
		isPrivate: false,
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

test('repo open session workflow and conversation conflict guard', async () => {
	resetMocks()
	mockModule.getActiveRepoSessionByConversation.mockResolvedValueOnce(null)
	mockModule.getSavedPackageByKodyId.mockResolvedValueOnce(
		createSavedPackageRow(),
	)
	mockModule.getEntitySourceByIdForUser.mockResolvedValueOnce(
		createPackageSourceRow(),
	)
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
	mockModule.getEntitySourceByIdForUser.mockResolvedValueOnce({
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
})

test('repo edit → commit → checks → publish session workflow', async () => {
	resetMocks()
	const workflowRpc = createRepoRpc()
	workflowRpc.applyEdits.mockResolvedValueOnce({
		dryRun: true,
		totalChanged: 3,
		edits: [
			{
				path: 'src/index.ts',
				changed: true,
				content: 'export const done = true\n',
				diff: '@@',
			},
			{
				path: 'src/remove.ts',
				changed: true,
				content: '',
				diff: '@@',
			},
			{
				path: 'src/new.ts',
				changed: true,
				content: 'moved\n',
				diff: '@@',
			},
		],
	})
	workflowRpc.sessionCommit.mockResolvedValueOnce({
		oid: 'commit-session-1',
		message: 'Update index',
	})
	workflowRpc.runChecks.mockResolvedValueOnce({
		ok: true,
		results: [{ kind: 'manifest', ok: true, message: 'Manifest ok' }],
		manifest: {
			name: '@kody/triage-github-pr',
			kody: { id: 'triage-github-pr', description: 'Triages one PR' },
		},
		runId: 'check-1',
		treeHash: 'tree-1',
		checkedAt: '2026-04-18T00:02:00.000Z',
	})
	workflowRpc.getSessionInfo.mockResolvedValue({
		id: 'session-existing',
		source_id: 'source-package-1',
		source_root: '/',
		base_commit: 'commit-package-1',
		session_branch: 'sessions/session-1',
		source_branch: 'main',
		conversation_id: 'conversation-1',
		last_checkpoint_commit: 'commit-session-1',
		last_check_run_id: 'check-1',
		last_check_tree_hash: 'tree-1',
		expires_at: null,
		created_at: '2026-04-18T00:01:00.000Z',
		updated_at: '2026-04-18T00:02:00.000Z',
		published_commit: 'commit-package-1',
		manifest_path: 'package.json',
		entity_type: 'package',
	})
	workflowRpc.publishSession.mockResolvedValueOnce({
		status: 'ok',
		sessionId: 'session-existing',
		publishedCommit: 'commit-published',
		message: 'Published session.',
	})
	workflowRpc.listPublishedPackageArtifactTargets.mockResolvedValueOnce([])
	mockModule.repoSessionRpc.mockReturnValue(workflowRpc)

	const edited = await repoEditFilesCapability.handler(
		{
			session_id: 'session-existing',
			edits: [
				{
					kind: 'write',
					path: 'src/index.ts',
					content: 'export const done = true\n',
				},
				{ kind: 'delete', path: 'src/remove.ts' },
				{ kind: 'move', path: 'src/old.ts', to: 'src/new.ts' },
			],
			dry_run: true,
			rollback_on_error: false,
		},
		createCapabilityContext(),
	)
	const committed = await repoCommitCapability.handler(
		{
			session_id: 'session-existing',
			message: 'Update index',
		},
		createCapabilityContext(),
	)
	const checks = await repoRunChecksCapability.handler(
		{ session_id: 'session-existing' },
		createCapabilityContext(),
	)
	const published = await repoPublishSessionCapability.handler(
		{ session_id: 'session-existing' },
		createCapabilityContext(),
	)

	expect(workflowRpc.applyEdits).toHaveBeenCalledWith({
		sessionId: 'session-existing',
		userId: 'user-1',
		edits: [
			{
				kind: 'write',
				path: 'src/index.ts',
				content: 'export const done = true\n',
			},
			{ kind: 'delete', path: 'src/remove.ts' },
			{ kind: 'move', path: 'src/old.ts', to: 'src/new.ts' },
		],
		dryRun: true,
		rollbackOnError: false,
	})
	expect(edited.total_changed).toBe(3)
	expect(edited.dry_run).toBe(true)
	expect(workflowRpc.sessionCommit).toHaveBeenCalledWith({
		sessionId: 'session-existing',
		userId: 'user-1',
		message: 'Update index',
	})
	expect(committed).toEqual({
		oid: 'commit-session-1',
		message: 'Update index',
	})
	expect(checks.ok).toBe(true)
	expect(published).toMatchObject({
		status: 'ok',
		session_id: 'session-existing',
		published_commit: 'commit-published',
	})
})

test('repo_publish_session covers base_moved repair, artifact rebuild, and rebuild failures', async () => {
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
