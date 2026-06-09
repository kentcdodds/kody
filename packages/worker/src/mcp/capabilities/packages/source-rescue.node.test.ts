import { expect, test, vi } from 'vitest'

const mockModule = vi.hoisted(() => ({
	resolveOwnedPackageSource: vi.fn(),
	resolveExistingArtifactSourceRepo: vi.fn(),
	resolveArtifactDefaultBranchHead: vi.fn(),
	listRepoSessionsBySource: vi.fn(),
	listPublishedBundleArtifactsBySourceId: vi.fn(),
	loadPublishedSourceSnapshot: vi.fn(),
	repoSessionRpc: vi.fn(),
	getMcpUserPackageScope: vi.fn(async () => '@kody'),
}))

vi.mock('./resolve-package-source.ts', () => ({
	resolveOwnedPackageSource: (...args: Array<unknown>) =>
		mockModule.resolveOwnedPackageSource(...args),
}))

vi.mock('#worker/repo/artifacts.ts', () => ({
	resolveExistingArtifactSourceRepo: (...args: Array<unknown>) =>
		mockModule.resolveExistingArtifactSourceRepo(...args),
	resolveArtifactDefaultBranchHead: (...args: Array<unknown>) =>
		mockModule.resolveArtifactDefaultBranchHead(...args),
}))

vi.mock('#worker/repo/repo-sessions.ts', () => ({
	listRepoSessionsBySource: (...args: Array<unknown>) =>
		mockModule.listRepoSessionsBySource(...args),
}))

vi.mock('#worker/repo/published-bundle-artifacts-repo.ts', () => ({
	listPublishedBundleArtifactsBySourceId: (...args: Array<unknown>) =>
		mockModule.listPublishedBundleArtifactsBySourceId(...args),
}))

vi.mock('#worker/package-runtime/published-runtime-artifacts.ts', () => ({
	loadPublishedSourceSnapshot: (...args: Array<unknown>) =>
		mockModule.loadPublishedSourceSnapshot(...args),
}))

vi.mock('#worker/repo/repo-session-do.ts', () => ({
	repoSessionRpc: (...args: Array<unknown>) =>
		mockModule.repoSessionRpc(...args),
}))

vi.mock('#worker/package-registry/user-scope.ts', () => ({
	getMcpUserPackageScope: (...args: Array<unknown>) =>
		mockModule.getMcpUserPackageScope(...args),
}))

const { sourceRescueCapability } = await import('./source-rescue.ts')

function resetMocks() {
	for (const fn of Object.values(mockModule)) {
		fn.mockReset()
	}
	mockModule.getMcpUserPackageScope.mockResolvedValue('@kody')
}

function createContext() {
	return {
		env: {
			APP_DB: {},
		} as unknown as Env,
		callerContext: {
			baseUrl: 'https://heykody.dev',
			user: {
				userId: 'user-1',
				email: 'user@example.com',
				displayName: 'User',
			},
			remoteConnectors: null,
			storageContext: null,
			repoContext: null,
		},
	}
}

function mockPackageSource() {
	mockModule.resolveOwnedPackageSource.mockResolvedValue({
		packageId: 'package-1',
		kodyId: 'demo',
		name: '@kody/demo',
		source: {
			id: 'source-1',
			user_id: 'user-1',
			entity_kind: 'package',
			entity_id: 'package-1',
			repo_id: 'repo-1',
			published_commit: 'commit-1',
			indexed_commit: 'commit-1',
			manifest_path: 'package.json',
			source_root: '/',
			last_external_check_at: null,
			created_at: '2026-06-06T00:00:00.000Z',
			updated_at: '2026-06-06T00:00:00.000Z',
		},
	})
	mockModule.resolveExistingArtifactSourceRepo.mockResolvedValue({
		info: vi.fn(),
		createToken: vi.fn(),
	})
	mockModule.resolveArtifactDefaultBranchHead.mockResolvedValue(null)
	mockModule.loadPublishedSourceSnapshot.mockResolvedValue({
		files: {
			'package.json': '{"name":"@kody/demo"}',
			'index.ts': 'export const ok = true\n',
		},
	})
	mockModule.listPublishedBundleArtifactsBySourceId.mockResolvedValue([
		{
			publishedCommit: 'commit-1',
			artifactKind: 'module',
			artifactName: null,
			entryPoint: 'index.ts',
			kvKey: 'bundle-artifact:v1:source-1:commit-1:module:_:index.ts',
		},
	])
}

function matchingSession() {
	return {
		id: 'session-1',
		user_id: 'user-1',
		source_id: 'source-1',
		session_repo_id: 'session-repo-1',
		session_repo_name: 'repo-1-session-1',
		session_repo_namespace: 'default',
		base_commit: 'commit-1',
		source_root: '/',
		conversation_id: null,
		status: 'active',
		expires_at: null,
		last_checkpoint_at: '2026-06-06T00:00:00.000Z',
		last_checkpoint_commit: 'commit-1',
		last_check_run_id: null,
		last_check_tree_hash: null,
		created_at: '2026-06-06T00:00:00.000Z',
		updated_at: '2026-06-06T00:00:00.000Z',
	}
}

test('package_source_rescue inspect reports verified repo session candidates and bundle evidence', async () => {
	resetMocks()
	mockPackageSource()
	mockModule.listRepoSessionsBySource.mockResolvedValue([matchingSession()])

	const result = await sourceRescueCapability.handler(
		{ package_id: 'package-1' },
		createContext(),
	)

	expect(result.status).toBe('recoverable')
	expect(result.repo_session_candidates).toEqual([
		expect.objectContaining({
			session_id: 'session-1',
			recovered_commit: 'commit-1',
			matches_published_commit: true,
		}),
	])
	expect(result.bundle_artifact_evidence).toEqual(
		expect.objectContaining({
			count_at_published_commit: 1,
			note: expect.stringContaining('evidence only'),
		}),
	)
})

test('package_source_rescue inspect reports the published matching commit as the recovery commit', async () => {
	resetMocks()
	mockPackageSource()
	mockModule.listRepoSessionsBySource.mockResolvedValue([
		{
			...matchingSession(),
			base_commit: 'commit-1',
			last_checkpoint_commit: 'commit-different',
		},
	])

	const result = await sourceRescueCapability.handler(
		{ package_id: 'package-1' },
		createContext(),
	)

	expect(result.status).toBe('recoverable')
	expect(result.repo_session_candidates).toEqual([
		expect.objectContaining({
			session_id: 'session-1',
			recovered_commit: 'commit-1',
			matches_published_commit: true,
		}),
	])
})

test('package_source_rescue inspect blocks recovery when only bundle artifacts exist', async () => {
	resetMocks()
	mockPackageSource()
	mockModule.listRepoSessionsBySource.mockResolvedValue([])

	const result = await sourceRescueCapability.handler(
		{ package_id: 'package-1' },
		createContext(),
	)

	expect(result.status).toBe('blocked')
	expect(result.repo_session_candidates).toEqual([])
	expect(result.recommended_next_action).toContain(
		'Do not use package_save or bundle artifacts to recreate source',
	)
})

test('package_source_rescue recover requires confirmation and delegates verified recovery', async () => {
	resetMocks()
	mockPackageSource()
	const session = matchingSession()
	mockModule.listRepoSessionsBySource.mockResolvedValue([session])
	const rpc = {
		recoverSourceFromSessionCheckpoint: vi.fn(async () => ({
			status: 'recovered',
			sourceId: 'source-1',
			packageId: 'package-1',
			recoveredCommit: 'commit-1',
			priorPublishedCommit: 'commit-1',
			sourceHeadBefore: null,
			sourceHeadAfter: 'commit-1',
			recoveredSessionId: 'session-1',
			recoveredRepoId: 'session-repo-1',
			recoveredRepoName: 'repo-1-session-1',
			validation: {
				ok: true,
				runId: 'run-1',
				treeHash: null,
				checkedAt: '',
				results: [],
			},
			auditEventId: 'source-rescue-event-1',
			message: 'Recovered.',
		})),
	}
	mockModule.repoSessionRpc.mockReturnValue(rpc)

	await expect(
		sourceRescueCapability.handler(
			{
				package_id: 'package-1',
				action: 'recover',
				recovery_source: { kind: 'repo_session', session_id: 'session-1' },
			},
			createContext(),
		),
	).rejects.toThrow('confirm_recovery: true')
	expect(rpc.recoverSourceFromSessionCheckpoint).not.toHaveBeenCalled()

	const result = await sourceRescueCapability.handler(
		{
			package_id: 'package-1',
			action: 'recover',
			confirm_recovery: true,
			recovery_source: { kind: 'repo_session', session_id: 'session-1' },
		},
		createContext(),
	)

	expect(result.status).toBe('recovered')
	expect(result.source_head).toEqual(
		expect.objectContaining({
			status: 'present',
			commit: 'commit-1',
			message: null,
		}),
	)
	expect(rpc.recoverSourceFromSessionCheckpoint).toHaveBeenCalledWith(
		expect.objectContaining({
			sessionId: 'session-1',
			sourceId: 'source-1',
			userId: 'user-1',
			packageId: 'package-1',
			kodyId: 'demo',
			recoveredCommit: 'commit-1',
			operatorUserId: 'user-1',
			operatorEmail: 'user@example.com',
			expectedPackageScope: '@kody',
		}),
	)
})

test('package_source_rescue recover defaults to the candidate commit that matches the published commit', async () => {
	resetMocks()
	mockPackageSource()
	const session = {
		...matchingSession(),
		base_commit: 'commit-1',
		last_checkpoint_commit: 'commit-different',
	}
	mockModule.listRepoSessionsBySource.mockResolvedValue([session])
	const rpc = {
		recoverSourceFromSessionCheckpoint: vi.fn(async () => ({
			status: 'recovered',
			sourceId: 'source-1',
			packageId: 'package-1',
			recoveredCommit: 'commit-1',
			priorPublishedCommit: 'commit-1',
			sourceHeadBefore: null,
			sourceHeadAfter: 'commit-1',
			recoveredSessionId: 'session-1',
			recoveredRepoId: 'session-repo-1',
			recoveredRepoName: 'repo-1-session-1',
			validation: {
				ok: true,
				runId: 'run-1',
				treeHash: null,
				checkedAt: '',
				results: [],
			},
			auditEventId: 'source-rescue-event-1',
			message: 'Recovered.',
		})),
	}
	mockModule.repoSessionRpc.mockReturnValue(rpc)

	await sourceRescueCapability.handler(
		{
			package_id: 'package-1',
			action: 'recover',
			confirm_recovery: true,
			recovery_source: { kind: 'repo_session', session_id: 'session-1' },
		},
		createContext(),
	)

	expect(rpc.recoverSourceFromSessionCheckpoint).toHaveBeenCalledWith(
		expect.objectContaining({
			recoveredCommit: 'commit-1',
		}),
	)
})

test('package_source_rescue recover rejects sources that already have a default branch HEAD', async () => {
	resetMocks()
	mockPackageSource()
	mockModule.resolveArtifactDefaultBranchHead.mockResolvedValue({
		remote: 'https://acct.artifacts.cloudflare.net/git/default/repo-1.git',
		defaultBranch: 'main',
		commit: 'commit-1',
	})
	mockModule.listRepoSessionsBySource.mockResolvedValue([matchingSession()])
	const rpc = {
		recoverSourceFromSessionCheckpoint: vi.fn(),
	}
	mockModule.repoSessionRpc.mockReturnValue(rpc)

	await expect(
		sourceRescueCapability.handler(
			{
				package_id: 'package-1',
				action: 'recover',
				confirm_recovery: true,
				recovery_source: { kind: 'repo_session', session_id: 'session-1' },
			},
			createContext(),
		),
	).rejects.toThrow(
		'package_source_rescue recover requires an existing source repo whose default branch has no HEAD; current status is "present".',
	)
	expect(rpc.recoverSourceFromSessionCheckpoint).not.toHaveBeenCalled()
})
