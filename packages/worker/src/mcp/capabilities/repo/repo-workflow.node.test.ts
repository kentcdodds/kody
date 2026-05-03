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
		env: { APP_DB: {} } as Env,
		callerContext: createMcpCallerContext({
			baseUrl: 'https://heykody.dev',
			user: { userId: 'user-1', email: 'user@example.com' },
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

test('repo_open_session resolves a package by kody id', async () => {
	resetMocks()
	mockModule.getActiveRepoSessionByConversation.mockResolvedValueOnce(null)
	mockModule.getSavedPackageByKodyId.mockResolvedValueOnce(
		createSavedPackageRow(),
	)
	mockModule.getEntitySourceById.mockResolvedValueOnce(createPackageSourceRow())
	const rpc = createRepoRpc()
	rpc.openSession.mockResolvedValueOnce({
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
	})
	mockModule.repoSessionRpc.mockReturnValue(rpc)

	const result = await repoOpenSessionCapability.handler(
		{
			target: { kind: 'package', kody_id: 'triage-github-pr' },
		},
		createCapabilityContext(),
	)

	expect(result.resolved_target).toEqual({
		kind: 'package',
		source_id: 'source-package-1',
		package_id: 'package-1',
		kody_id: 'triage-github-pr',
		name: '@kody/triage-github-pr',
	})
	expect(rpc.openSession).toHaveBeenCalledWith(
		expect.objectContaining({
			sourceId: 'source-package-1',
			userId: 'user-1',
			sourceRoot: '/',
		}),
	)
})

test('repo_open_session rejects an active conversation session for a different target source', async () => {
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
})

test('repo_run_commands reuses resolved target metadata when resuming an existing session', async () => {
	resetMocks()
	mockModule.getSavedPackageById
		.mockResolvedValueOnce(createSavedPackageRow())
		.mockResolvedValueOnce(createSavedPackageRow())
	mockModule.getEntitySourceById
		.mockResolvedValueOnce(createPackageSourceRow())
		.mockResolvedValueOnce(createPackageSourceRow())
	const rpc = createRepoRpc()
	rpc.getSessionInfo.mockResolvedValueOnce({
		id: 'session-existing',
		source_id: 'source-package-1',
		source_root: '/',
		base_commit: 'commit-package-1',
		session_repo_id: 'session-repo-1',
		session_repo_name: 'repo-package-1-session-1',
		session_repo_namespace: 'default',
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
	rpc.getSessionInfo.mockResolvedValueOnce({
		id: 'session-existing',
		source_id: 'source-package-1',
		source_root: '/',
		base_commit: 'commit-package-1',
		session_repo_id: 'session-repo-1',
		session_repo_name: 'repo-package-1-session-1',
		session_repo_namespace: 'default',
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
	rpc.runCommands.mockResolvedValueOnce({
		session: {
			id: 'session-existing',
			source_id: 'source-package-1',
			source_root: '/',
			base_commit: 'commit-package-1',
			session_repo_id: 'session-repo-1',
			session_repo_name: 'repo-package-1-session-1',
			session_repo_namespace: 'default',
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
	mockModule.repoSessionRpc.mockReturnValue(rpc)

	const result = await repoRunCommandsCapability.handler(
		{
			session_id: 'session-existing',
			commands: 'git status',
			run_checks: false,
			publish: false,
		},
		createCapabilityContext(),
	)

	expect(rpc.runCommands).toHaveBeenCalledWith({
		sessionId: 'session-existing',
		userId: 'user-1',
		commands: 'git status',
		dryRun: undefined,
		runChecks: false,
		publish: false,
	})
	expect(result.commands).toEqual([
		{ line: 1, command: 'git status', ok: true, output: [] },
	])
	expect(result.resolved_target).toEqual({
		kind: 'package',
		source_id: 'source-package-1',
		package_id: 'package-1',
		kody_id: 'triage-github-pr',
		name: '@kody/triage-github-pr',
	})
})

test('repo_run_commands opens by target and returns failed checks without publish', async () => {
	resetMocks()
	mockModule.getActiveRepoSessionByConversation.mockResolvedValueOnce(null)
	mockModule.getSavedPackageByKodyId.mockResolvedValueOnce(
		createSavedPackageRow(),
	)
	mockModule.getSavedPackageById.mockResolvedValueOnce(createSavedPackageRow())
	mockModule.getEntitySourceById
		.mockResolvedValueOnce(createPackageSourceRow())
		.mockResolvedValueOnce(createPackageSourceRow())
	const rpc = createRepoRpc()
	rpc.openSession.mockResolvedValueOnce({
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
	})
	rpc.runCommands.mockResolvedValueOnce({
		session: {
			id: 'session-1',
			source_id: 'source-package-1',
			source_root: '/',
			base_commit: 'commit-package-1',
			session_repo_id: 'session-repo-1',
			session_repo_name: 'repo-package-1-session-1',
			session_repo_namespace: 'default',
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
	mockModule.repoSessionRpc.mockReturnValue(rpc)

	const commands = [
		"git apply <<'PATCH'",
		'--- a/src/index.ts',
		'+++ b/src/index.ts',
		'PATCH',
	].join('\n')
	const result = await repoRunCommandsCapability.handler(
		{
			target: { kind: 'package', kody_id: 'triage-github-pr' },
			commands,
			run_checks: true,
			publish: true,
		},
		createCapabilityContext(),
	)

	expect(rpc.runCommands).toHaveBeenCalledWith({
		sessionId: 'session-1',
		userId: 'user-1',
		commands,
		dryRun: undefined,
		runChecks: true,
		publish: true,
	})
	expect(result.checks).toEqual({
		status: 'failed',
		ok: false,
		results: [
			{ kind: 'typecheck', ok: false, message: 'Typecheck failed' },
			{ kind: 'manifest', ok: true, message: 'Manifest ok' },
		],
		failed_checks: [
			{ kind: 'typecheck', ok: false, message: 'Typecheck failed' },
		],
		manifest: {
			name: '@kody/triage-github-pr',
			kody_id: 'triage-github-pr',
			description: 'Triages one PR',
			has_app: false,
		},
		run_id: 'check-1',
		tree_hash: 'tree-1',
		checked_at: '2026-04-18T00:02:00.000Z',
	})
	expect(result.publish).toEqual({
		status: 'blocked_by_checks',
		message: 'Publishing skipped because repo checks failed.',
	})
})

test('repo_run_commands returns published result after checks pass', async () => {
	resetMocks()
	mockModule.getSavedPackageById
		.mockResolvedValueOnce(createSavedPackageRow())
		.mockResolvedValueOnce(createSavedPackageRow())
	mockModule.getEntitySourceById
		.mockResolvedValueOnce(createPackageSourceRow())
		.mockResolvedValueOnce(createPackageSourceRow())
	const rpc = createRepoRpc()
	rpc.getSessionInfo.mockResolvedValueOnce({
		id: 'session-existing',
		source_id: 'source-package-1',
		source_root: '/',
		base_commit: 'commit-package-1',
		session_repo_id: 'session-repo-1',
		session_repo_name: 'repo-package-1-session-1',
		session_repo_namespace: 'default',
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
	rpc.getSessionInfo.mockResolvedValueOnce({
		id: 'session-existing',
		source_id: 'source-package-1',
		source_root: '/',
		base_commit: 'commit-package-1',
		session_repo_id: 'session-repo-1',
		session_repo_name: 'repo-package-1-session-1',
		session_repo_namespace: 'default',
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
	rpc.runCommands.mockResolvedValueOnce({
		session: {
			id: 'session-existing',
			source_id: 'source-package-1',
			source_root: '/',
			base_commit: 'commit-package-1',
			session_repo_id: 'session-repo-1',
			session_repo_name: 'repo-package-1-session-1',
			session_repo_namespace: 'default',
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
		publish: {
			status: 'ok',
			sessionId: 'session-existing',
			publishedCommit: 'commit-published',
			message: 'Published session.',
		},
	})
	mockModule.repoSessionRpc.mockReturnValue(rpc)

	const result = await repoRunCommandsCapability.handler(
		{
			session_id: 'session-existing',
			commands: 'git status',
			run_checks: true,
			publish: true,
		},
		createCapabilityContext(),
	)

	expect(result.checks).toEqual({
		status: 'passed',
		ok: true,
		results: [{ kind: 'manifest', ok: true, message: 'Manifest ok' }],
		manifest: {
			name: '@kody/triage-github-pr',
			kody_id: 'triage-github-pr',
			description: 'Triages one PR',
			has_app: false,
		},
		run_id: 'check-1',
		tree_hash: 'tree-1',
		checked_at: '2026-04-18T00:02:00.000Z',
	})
	expect(result.publish).toEqual({
		status: 'ok',
		session_id: 'session-existing',
		published_commit: 'commit-published',
		message: 'Published session.',
	})
})

test('repo_publish_session returns structured base_moved repair details', async () => {
	resetMocks()
	const rpc = createRepoRpc()
	rpc.publishSession.mockResolvedValueOnce({
		status: 'base_moved',
		sessionId: 'session-1',
		publishedCommit: null,
		message:
			'The source repo has moved since this session opened. Rebase the session before publishing.',
		repairHint: 'repo_rebase_session',
		sessionBaseCommit: 'commit-old',
		currentPublishedCommit: 'commit-new',
	})
	mockModule.repoSessionRpc.mockReturnValue(rpc)

	const result = await repoPublishSessionCapability.handler(
		{
			session_id: 'session-1',
		},
		createCapabilityContext(),
	)

	expect(result).toEqual({
		status: 'base_moved',
		session_id: 'session-1',
		published_commit: null,
		message:
			'The source repo has moved since this session opened. Rebase the session before publishing.',
		repair_hint: 'repo_rebase_session',
		session_base_commit: 'commit-old',
		current_published_commit: 'commit-new',
	})
})

test('repo_run_commands surfaces line-specific command parse errors', async () => {
	resetMocks()
	const rpc = createRepoRpc()
	rpc.getSessionInfo.mockResolvedValueOnce({
		id: 'session-existing',
		source_id: 'source-package-1',
		source_root: '/',
		base_commit: 'commit-package-1',
		session_repo_id: 'session-repo-1',
		session_repo_name: 'repo-package-1-session-1',
		session_repo_namespace: 'default',
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
	rpc.runCommands.mockRejectedValueOnce(
		new Error(
			'Unable to parse repo command on line 2: unsupported git subcommand "merge".',
		),
	)
	mockModule.repoSessionRpc.mockReturnValue(rpc)
	mockModule.getSavedPackageById.mockResolvedValueOnce(createSavedPackageRow())
	mockModule.getEntitySourceById.mockResolvedValueOnce(createPackageSourceRow())

	await expect(
		repoRunCommandsCapability.handler(
			{
				session_id: 'session-existing',
				commands: 'git status\ngit merge main',
			},
			createCapabilityContext(),
		),
	).rejects.toThrow(
		'Unable to parse repo command on line 2: unsupported git subcommand "merge".',
	)
})
