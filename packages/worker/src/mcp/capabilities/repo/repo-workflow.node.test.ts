import { expect, test, vi } from 'vitest'
import { createMcpCallerContext } from '#mcp/context.ts'

const mockModule = vi.hoisted(() => ({
	getActiveRepoSessionByConversation: vi.fn(),
	getEntitySourceById: vi.fn(),
	getMcpSkillByNameInput: vi.fn(),
	listMcpSkillsByUserId: vi.fn(),
	getUiArtifactById: vi.fn(),
	getJobRowById: vi.fn(),
	listJobRowsByUserId: vi.fn(),
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

vi.mock('#mcp/skills/mcp-skills-repo.ts', () => ({
	getMcpSkillByNameInput: (...args: Array<unknown>) =>
		mockModule.getMcpSkillByNameInput(...args),
	listMcpSkillsByUserId: (...args: Array<unknown>) =>
		mockModule.listMcpSkillsByUserId(...args),
}))

vi.mock('#mcp/ui-artifacts-repo.ts', () => ({
	getUiArtifactById: (...args: Array<unknown>) =>
		mockModule.getUiArtifactById(...args),
}))

vi.mock('#worker/jobs/repo.ts', () => ({
	getJobRowById: (...args: Array<unknown>) => mockModule.getJobRowById(...args),
	listJobRowsByUserId: (...args: Array<unknown>) =>
		mockModule.listJobRowsByUserId(...args),
}))

vi.mock('#worker/repo/repo-session-do.ts', () => ({
	repoSessionRpc: (...args: Array<unknown>) =>
		mockModule.repoSessionRpc(...args),
}))

const { repoOpenSessionCapability } = await import('./repo-open-session.ts')
const { repoEditFlowCapability } = await import('./repo-edit-flow.ts')
const { repoPublishSessionCapability } =
	await import('./repo-publish-session.ts')

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
		applyEdits: vi.fn(),
		runChecks: vi.fn(),
		publishSession: vi.fn(),
		...overrides,
	}
}

test('repo_open_session resolves a saved skill by name', async () => {
	mockModule.getActiveRepoSessionByConversation.mockReset()
	mockModule.getEntitySourceById.mockReset()
	mockModule.getMcpSkillByNameInput.mockReset()
	mockModule.listMcpSkillsByUserId.mockReset()
	mockModule.getUiArtifactById.mockReset()
	mockModule.getJobRowById.mockReset()
	mockModule.listJobRowsByUserId.mockReset()
	mockModule.repoSessionRpc.mockReset()

	mockModule.getActiveRepoSessionByConversation.mockResolvedValueOnce(null)
	mockModule.getMcpSkillByNameInput.mockResolvedValueOnce({
		id: 'skill-1',
		user_id: 'user-1',
		name: 'triage-github-pr',
		title: 'Triage GitHub PR',
		description: 'Triages one PR',
		source_id: 'source-skill-1',
		keywords: '[]',
		search_text: null,
		uses_capabilities: null,
		parameters: null,
		collection_name: null,
		collection_slug: null,
		inferred_capabilities: '[]',
		inference_partial: 0,
		read_only: 1,
		idempotent: 1,
		destructive: 0,
		created_at: '2026-04-18T00:00:00.000Z',
		updated_at: '2026-04-18T00:00:00.000Z',
	})
	mockModule.getEntitySourceById.mockResolvedValueOnce({
		id: 'source-skill-1',
		user_id: 'user-1',
		entity_kind: 'skill',
		entity_id: 'skill-1',
		repo_id: 'repo-skill-1',
		published_commit: 'commit-skill-1',
		indexed_commit: 'commit-skill-1',
		manifest_path: 'kody.json',
		source_root: '/',
		created_at: '2026-04-18T00:00:00.000Z',
		updated_at: '2026-04-18T00:00:00.000Z',
	})
	const rpc = createRepoRpc()
	rpc.openSession.mockResolvedValueOnce({
		id: 'session-1',
		source_id: 'source-skill-1',
		source_root: '/',
		base_commit: 'commit-skill-1',
		session_repo_id: 'session-repo-1',
		session_repo_name: 'repo-skill-1-session-1',
		session_repo_namespace: 'default',
		conversation_id: null,
		last_checkpoint_commit: 'commit-skill-1',
		last_check_run_id: null,
		last_check_tree_hash: null,
		expires_at: null,
		created_at: '2026-04-18T00:01:00.000Z',
		updated_at: '2026-04-18T00:01:00.000Z',
		published_commit: 'commit-skill-1',
		manifest_path: 'kody.json',
		entity_type: 'skill',
	})
	mockModule.repoSessionRpc.mockReturnValue(rpc)

	const result = await repoOpenSessionCapability.handler(
		{
			target: { kind: 'skill', name: 'triage-github-pr' },
		},
		createCapabilityContext(),
	)

	expect(rpc.openSession).toHaveBeenCalledWith(
		expect.objectContaining({
			sourceId: 'source-skill-1',
			userId: 'user-1',
			sourceRoot: '/',
		}),
	)
	expect(result.resolved_target).toEqual({
		kind: 'skill',
		source_id: 'source-skill-1',
		skill_id: 'skill-1',
		name: 'triage-github-pr',
	})
})

test('repo_open_session resolves a saved job by id', async () => {
	mockModule.getActiveRepoSessionByConversation.mockReset()
	mockModule.getEntitySourceById.mockReset()
	mockModule.getMcpSkillByNameInput.mockReset()
	mockModule.listMcpSkillsByUserId.mockReset()
	mockModule.getUiArtifactById.mockReset()
	mockModule.getJobRowById.mockReset()
	mockModule.listJobRowsByUserId.mockReset()
	mockModule.repoSessionRpc.mockReset()

	mockModule.getActiveRepoSessionByConversation.mockResolvedValueOnce(null)
	mockModule.getJobRowById.mockResolvedValueOnce({
		id: 'job-1',
		user_id: 'user-1',
		name: 'Nightly inbox sweep',
		source_id: 'source-job-1',
		published_commit: 'commit-job-1',
		repo_check_policy_json: null,
		storage_id: 'job:job-1',
		params_json: null,
		schedule_json: '{"type":"interval","every":"1h"}',
		timezone: 'UTC',
		enabled: 1,
		kill_switch_enabled: 0,
		caller_context_json: '{}',
		created_at: '2026-04-18T00:00:00.000Z',
		updated_at: '2026-04-18T00:00:00.000Z',
		last_run_at: null,
		last_run_status: null,
		last_run_error: null,
		last_duration_ms: null,
		next_run_at: '2026-04-18T01:00:00.000Z',
		run_count: 0,
		success_count: 0,
		error_count: 0,
		run_history_json: '[]',
		record: {
			version: 1,
			id: 'job-1',
			userId: 'user-1',
			name: 'Nightly inbox sweep',
			sourceId: 'source-job-1',
			publishedCommit: 'commit-job-1',
			storageId: 'job:job-1',
			schedule: { type: 'interval', every: '1h' },
			timezone: 'UTC',
			enabled: true,
			killSwitchEnabled: false,
			createdAt: '2026-04-18T00:00:00.000Z',
			updatedAt: '2026-04-18T00:00:00.000Z',
			nextRunAt: '2026-04-18T01:00:00.000Z',
			runCount: 0,
			successCount: 0,
			errorCount: 0,
			runHistory: [],
		},
		callerContextJson: '{}',
		callerContext: null,
	})
	mockModule.getEntitySourceById.mockResolvedValueOnce({
		id: 'source-job-1',
		user_id: 'user-1',
		entity_kind: 'job',
		entity_id: 'job-1',
		repo_id: 'repo-job-1',
		published_commit: 'commit-job-1',
		indexed_commit: 'commit-job-1',
		manifest_path: 'kody.json',
		source_root: '/',
		created_at: '2026-04-18T00:00:00.000Z',
		updated_at: '2026-04-18T00:00:00.000Z',
	})
	const rpc = createRepoRpc()
	rpc.openSession.mockResolvedValueOnce({
		id: 'session-job-1',
		source_id: 'source-job-1',
		source_root: '/',
		base_commit: 'commit-job-1',
		session_repo_id: 'session-repo-job-1',
		session_repo_name: 'repo-job-1-session',
		session_repo_namespace: 'default',
		conversation_id: null,
		last_checkpoint_commit: 'commit-job-1',
		last_check_run_id: null,
		last_check_tree_hash: null,
		expires_at: null,
		created_at: '2026-04-18T00:01:00.000Z',
		updated_at: '2026-04-18T00:01:00.000Z',
		published_commit: 'commit-job-1',
		manifest_path: 'kody.json',
		entity_type: 'job',
	})
	mockModule.repoSessionRpc.mockReturnValue(rpc)

	const result = await repoOpenSessionCapability.handler(
		{
			target: { kind: 'job', job_id: 'job-1' },
		},
		createCapabilityContext(),
	)

	expect(result.resolved_target).toEqual({
		kind: 'job',
		source_id: 'source-job-1',
		job_id: 'job-1',
		name: 'Nightly inbox sweep',
	})
})

test('repo_open_session resolves a saved app by app_id', async () => {
	mockModule.getActiveRepoSessionByConversation.mockReset()
	mockModule.getEntitySourceById.mockReset()
	mockModule.getMcpSkillByNameInput.mockReset()
	mockModule.listMcpSkillsByUserId.mockReset()
	mockModule.getUiArtifactById.mockReset()
	mockModule.getJobRowById.mockReset()
	mockModule.listJobRowsByUserId.mockReset()
	mockModule.repoSessionRpc.mockReset()

	mockModule.getActiveRepoSessionByConversation.mockResolvedValueOnce(null)
	mockModule.getUiArtifactById.mockResolvedValueOnce({
		id: 'app-1',
		user_id: 'user-1',
		title: 'Repo App',
		description: 'App description',
		sourceId: 'source-app-1',
		hasServerCode: true,
		parameters: null,
		hidden: false,
		created_at: '2026-04-18T00:00:00.000Z',
		updated_at: '2026-04-18T00:00:00.000Z',
	})
	mockModule.getEntitySourceById.mockResolvedValueOnce({
		id: 'source-app-1',
		user_id: 'user-1',
		entity_kind: 'app',
		entity_id: 'app-1',
		repo_id: 'repo-app-1',
		published_commit: 'commit-app-1',
		indexed_commit: 'commit-app-1',
		manifest_path: 'kody.json',
		source_root: '/',
		created_at: '2026-04-18T00:00:00.000Z',
		updated_at: '2026-04-18T00:00:00.000Z',
	})
	const rpc = createRepoRpc()
	rpc.openSession.mockResolvedValueOnce({
		id: 'session-app-1',
		source_id: 'source-app-1',
		source_root: '/',
		base_commit: 'commit-app-1',
		session_repo_id: 'session-repo-app-1',
		session_repo_name: 'repo-app-1-session',
		session_repo_namespace: 'default',
		conversation_id: null,
		last_checkpoint_commit: 'commit-app-1',
		last_check_run_id: null,
		last_check_tree_hash: null,
		expires_at: null,
		created_at: '2026-04-18T00:01:00.000Z',
		updated_at: '2026-04-18T00:01:00.000Z',
		published_commit: 'commit-app-1',
		manifest_path: 'kody.json',
		entity_type: 'app',
	})
	mockModule.repoSessionRpc.mockReturnValue(rpc)

	const result = await repoOpenSessionCapability.handler(
		{
			target: { kind: 'app', app_id: 'app-1' },
		},
		createCapabilityContext(),
	)

	expect(result.resolved_target).toEqual({
		kind: 'app',
		source_id: 'source-app-1',
		app_id: 'app-1',
		title: 'Repo App',
	})
})

test('repo_open_session rejects an active conversation session for a different target source', async () => {
	mockModule.getActiveRepoSessionByConversation.mockReset()
	mockModule.getEntitySourceById.mockReset()
	mockModule.getMcpSkillByNameInput.mockReset()
	mockModule.listMcpSkillsByUserId.mockReset()
	mockModule.getUiArtifactById.mockReset()
	mockModule.getJobRowById.mockReset()
	mockModule.listJobRowsByUserId.mockReset()
	mockModule.repoSessionRpc.mockReset()

	mockModule.getActiveRepoSessionByConversation.mockResolvedValueOnce({
		id: 'session-existing',
		source_id: 'source-existing',
	})
	mockModule.getMcpSkillByNameInput.mockResolvedValueOnce({
		id: 'skill-1',
		user_id: 'user-1',
		name: 'triage-github-pr',
		title: 'Triage GitHub PR',
		description: 'Triages one PR',
		source_id: 'source-requested',
		keywords: '[]',
		search_text: null,
		uses_capabilities: null,
		parameters: null,
		collection_name: null,
		collection_slug: null,
		inferred_capabilities: '[]',
		inference_partial: 0,
		read_only: 1,
		idempotent: 1,
		destructive: 0,
		created_at: '2026-04-18T00:00:00.000Z',
		updated_at: '2026-04-18T00:00:00.000Z',
	})
	mockModule.getEntitySourceById.mockResolvedValueOnce({
		id: 'source-requested',
		user_id: 'user-1',
		entity_kind: 'skill',
		entity_id: 'skill-1',
		repo_id: 'repo-skill-1',
		published_commit: 'commit-skill-1',
		indexed_commit: 'commit-skill-1',
		manifest_path: 'kody.json',
		source_root: '/',
		created_at: '2026-04-18T00:00:00.000Z',
		updated_at: '2026-04-18T00:00:00.000Z',
	})

	const rpc = createRepoRpc()
	mockModule.repoSessionRpc.mockReturnValue(rpc)

	await expect(
		repoOpenSessionCapability.handler(
			{
				target: { kind: 'skill', name: 'triage-github-pr' },
				conversation_id: 'conversation-1',
			},
			createCapabilityContext(),
		),
	).rejects.toThrow(
		'Active repo session does not match the requested source. Discard the current session before opening a new source.',
	)

	expect(rpc.getSessionInfo).not.toHaveBeenCalled()
	expect(rpc.openSession).not.toHaveBeenCalled()
})

test('repo_open_session reuses resolved target metadata when resuming an existing session', async () => {
	mockModule.getActiveRepoSessionByConversation.mockReset()
	mockModule.getEntitySourceById.mockReset()
	mockModule.getMcpSkillByNameInput.mockReset()
	mockModule.listMcpSkillsByUserId.mockReset()
	mockModule.getUiArtifactById.mockReset()
	mockModule.getJobRowById.mockReset()
	mockModule.listJobRowsByUserId.mockReset()
	mockModule.repoSessionRpc.mockReset()

	mockModule.getMcpSkillByNameInput.mockResolvedValueOnce({
		id: 'skill-1',
		user_id: 'user-1',
		name: 'triage-github-pr',
		title: 'Triage GitHub PR',
		description: 'Triages one PR',
		source_id: 'source-skill-1',
		keywords: '[]',
		search_text: null,
		uses_capabilities: null,
		parameters: null,
		collection_name: null,
		collection_slug: null,
		inferred_capabilities: '[]',
		inference_partial: 0,
		read_only: 1,
		idempotent: 1,
		destructive: 0,
		created_at: '2026-04-18T00:00:00.000Z',
		updated_at: '2026-04-18T00:00:00.000Z',
	})
	mockModule.getEntitySourceById.mockResolvedValueOnce({
		id: 'source-skill-1',
		user_id: 'user-1',
		entity_kind: 'skill',
		entity_id: 'skill-1',
		repo_id: 'repo-skill-1',
		published_commit: 'commit-skill-1',
		indexed_commit: 'commit-skill-1',
		manifest_path: 'kody.json',
		source_root: '/',
		created_at: '2026-04-18T00:00:00.000Z',
		updated_at: '2026-04-18T00:00:00.000Z',
	})
	mockModule.getActiveRepoSessionByConversation.mockResolvedValueOnce({
		id: 'session-existing',
		source_id: 'source-skill-1',
	})
	const rpc = createRepoRpc()
	rpc.getSessionInfo.mockResolvedValueOnce({
		id: 'session-existing',
		source_id: 'source-skill-1',
		source_root: '/',
		base_commit: 'commit-skill-1',
		session_repo_id: 'session-repo-1',
		session_repo_name: 'repo-skill-1-session-1',
		session_repo_namespace: 'default',
		conversation_id: 'conversation-1',
		last_checkpoint_commit: 'commit-skill-1',
		last_check_run_id: null,
		last_check_tree_hash: null,
		expires_at: null,
		created_at: '2026-04-18T00:01:00.000Z',
		updated_at: '2026-04-18T00:02:00.000Z',
		published_commit: 'commit-skill-1',
		manifest_path: 'kody.json',
		entity_type: 'skill',
	})
	mockModule.repoSessionRpc.mockReturnValue(rpc)

	const result = await repoOpenSessionCapability.handler(
		{
			target: { kind: 'skill', name: 'triage-github-pr' },
			conversation_id: 'conversation-1',
		},
		createCapabilityContext(),
	)

	expect(result.resolved_target).toEqual({
		kind: 'skill',
		source_id: 'source-skill-1',
		skill_id: 'skill-1',
		name: 'triage-github-pr',
	})
	expect(mockModule.listMcpSkillsByUserId).not.toHaveBeenCalled()
	expect(mockModule.getJobRowById).not.toHaveBeenCalled()
	expect(mockModule.getUiArtifactById).not.toHaveBeenCalled()
	expect(mockModule.getEntitySourceById).toHaveBeenCalledTimes(1)
})

test('repo_edit_flow applies edits, runs checks, and skips publish when checks fail', async () => {
	mockModule.getActiveRepoSessionByConversation.mockReset()
	mockModule.getEntitySourceById.mockReset()
	mockModule.getMcpSkillByNameInput.mockReset()
	mockModule.listMcpSkillsByUserId.mockReset()
	mockModule.getUiArtifactById.mockReset()
	mockModule.getJobRowById.mockReset()
	mockModule.listJobRowsByUserId.mockReset()
	mockModule.repoSessionRpc.mockReset()

	mockModule.getActiveRepoSessionByConversation.mockResolvedValueOnce(null)
	mockModule.getMcpSkillByNameInput.mockResolvedValueOnce({
		id: 'skill-1',
		user_id: 'user-1',
		name: 'triage-github-pr',
		title: 'Triage GitHub PR',
		description: 'Triages one PR',
		source_id: 'source-skill-1',
		keywords: '[]',
		search_text: null,
		uses_capabilities: null,
		parameters: null,
		collection_name: null,
		collection_slug: null,
		inferred_capabilities: '[]',
		inference_partial: 0,
		read_only: 1,
		idempotent: 1,
		destructive: 0,
		created_at: '2026-04-18T00:00:00.000Z',
		updated_at: '2026-04-18T00:00:00.000Z',
	})
	mockModule.getEntitySourceById
		.mockResolvedValueOnce({
			id: 'source-skill-1',
			user_id: 'user-1',
			entity_kind: 'skill',
			entity_id: 'skill-1',
			repo_id: 'repo-skill-1',
			published_commit: 'commit-skill-1',
			indexed_commit: 'commit-skill-1',
			manifest_path: 'kody.json',
			source_root: '/',
			created_at: '2026-04-18T00:00:00.000Z',
			updated_at: '2026-04-18T00:00:00.000Z',
		})
		.mockResolvedValueOnce({
			id: 'source-skill-1',
			user_id: 'user-1',
			entity_kind: 'skill',
			entity_id: 'skill-1',
			repo_id: 'repo-skill-1',
			published_commit: 'commit-skill-1',
			indexed_commit: 'commit-skill-1',
			manifest_path: 'kody.json',
			source_root: '/',
			created_at: '2026-04-18T00:00:00.000Z',
			updated_at: '2026-04-18T00:00:00.000Z',
		})
	mockModule.listMcpSkillsByUserId.mockResolvedValueOnce([
		{
			id: 'skill-1',
			user_id: 'user-1',
			name: 'triage-github-pr',
			title: 'Triage GitHub PR',
			description: 'Triages one PR',
			source_id: 'source-skill-1',
			keywords: '[]',
			search_text: null,
			uses_capabilities: null,
			parameters: null,
			collection_name: null,
			collection_slug: null,
			inferred_capabilities: '[]',
			inference_partial: 0,
			read_only: 1,
			idempotent: 1,
			destructive: 0,
			created_at: '2026-04-18T00:00:00.000Z',
			updated_at: '2026-04-18T00:00:00.000Z',
		},
	])
	const rpc = createRepoRpc()
	rpc.openSession.mockResolvedValueOnce({
		id: 'session-1',
		source_id: 'source-skill-1',
		source_root: '/',
		base_commit: 'commit-skill-1',
		session_repo_id: 'session-repo-1',
		session_repo_name: 'repo-skill-1-session-1',
		session_repo_namespace: 'default',
		conversation_id: null,
		last_checkpoint_commit: 'commit-skill-1',
		last_check_run_id: null,
		last_check_tree_hash: null,
		expires_at: null,
		created_at: '2026-04-18T00:01:00.000Z',
		updated_at: '2026-04-18T00:01:00.000Z',
		published_commit: 'commit-skill-1',
		manifest_path: 'kody.json',
		entity_type: 'skill',
	})
	rpc.applyEdits.mockResolvedValueOnce({
		dryRun: false,
		totalChanged: 1,
		edits: [
			{
				path: 'src/skill.ts',
				changed: true,
				content: 'export default async () => ({ ok: true })',
				diff: '@@',
			},
		],
	})
	rpc.runChecks.mockResolvedValueOnce({
		ok: false,
		results: [
			{ kind: 'typecheck', ok: false, message: 'Typecheck failed' },
			{ kind: 'manifest', ok: true, message: 'Manifest ok' },
		],
		manifest: {
			version: 1,
			kind: 'skill',
			title: 'Triage GitHub PR',
			description: 'Triages one PR',
		},
		runId: 'check-1',
		treeHash: 'tree-1',
		checkedAt: '2026-04-18T00:02:00.000Z',
	})
	rpc.getSessionInfo.mockResolvedValueOnce({
		id: 'session-1',
		source_id: 'source-skill-1',
		source_root: '/',
		base_commit: 'commit-skill-1',
		session_repo_id: 'session-repo-1',
		session_repo_name: 'repo-skill-1-session-1',
		session_repo_namespace: 'default',
		conversation_id: null,
		last_checkpoint_commit: 'commit-skill-1',
		last_check_run_id: 'check-1',
		last_check_tree_hash: 'tree-1',
		expires_at: null,
		created_at: '2026-04-18T00:01:00.000Z',
		updated_at: '2026-04-18T00:02:00.000Z',
		published_commit: 'commit-skill-1',
		manifest_path: 'kody.json',
		entity_type: 'skill',
	})
	mockModule.repoSessionRpc.mockReturnValue(rpc)

	const result = await repoEditFlowCapability.handler(
		{
			target: { kind: 'skill', name: 'triage-github-pr' },
			instructions: [
				{
					kind: 'replace',
					path: 'src/skill.ts',
					search: 'return { ok: false }',
					replacement: 'return { ok: true }',
				},
			],
		},
		createCapabilityContext(),
	)

	expect(rpc.applyEdits).toHaveBeenCalledTimes(1)
	expect(rpc.runChecks).toHaveBeenCalledTimes(1)
	expect(rpc.publishSession).not.toHaveBeenCalled()
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
			version: 1,
			kind: 'skill',
			title: 'Triage GitHub PR',
			description: 'Triages one PR',
		},
		run_id: 'check-1',
		tree_hash: 'tree-1',
		checked_at: '2026-04-18T00:02:00.000Z',
	})
	expect(result.publish).toEqual({
		status: 'blocked_by_checks',
		message: 'Publishing skipped because repo checks failed in this flow.',
		failed_checks: [
			{ kind: 'typecheck', ok: false, message: 'Typecheck failed' },
		],
		run_id: 'check-1',
		tree_hash: 'tree-1',
		checked_at: '2026-04-18T00:02:00.000Z',
	})
})

test('repo_publish_session returns structured base_moved repair details', async () => {
	mockModule.repoSessionRpc.mockReset()
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
