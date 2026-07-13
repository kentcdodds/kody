import { expect, test, vi } from 'vitest'
import { createMcpCallerContext } from '#mcp/context.ts'

const mockModule = vi.hoisted(() => ({
	getEntitySourceByIdForUser: vi.fn(),
	getSavedPackageById: vi.fn(),
	listRepoSessionsBySource: vi.fn(),
	listRepoSessionsByUser: vi.fn(),
}))

vi.mock('#worker/repo/entity-sources.ts', () => ({
	getEntitySourceByIdForUser: (...args: Array<unknown>) =>
		mockModule.getEntitySourceByIdForUser(...args),
}))

vi.mock('#worker/package-registry/repo.ts', () => ({
	getSavedPackageById: (...args: Array<unknown>) =>
		mockModule.getSavedPackageById(...args),
}))

vi.mock('#worker/repo/repo-sessions.ts', () => ({
	listRepoSessionsBySource: (...args: Array<unknown>) =>
		mockModule.listRepoSessionsBySource(...args),
	listRepoSessionsByUser: (...args: Array<unknown>) =>
		mockModule.listRepoSessionsByUser(...args),
}))

const { repoListSessionsCapability } = await import('./repo-list-sessions.ts')

function resetMocks() {
	for (const fn of Object.values(mockModule)) {
		fn.mockReset()
	}
}

function createContext(userId = 'user-1') {
	return {
		env: { APP_DB: {} } as Env,
		callerContext: createMcpCallerContext({
			baseUrl: 'https://heykody.dev',
			user: {
				userId,
				email: `${userId}@example.com`,
				displayName: userId,
			},
		}),
	}
}

function createSession(
	overrides: Partial<{
		id: string
		user_id: string
		source_id: string
		status: 'active' | 'published' | 'discarded'
		updated_at: string
	}> = {},
) {
	const id = overrides.id ?? 'session-active'
	const sourceId = overrides.source_id ?? 'source-1'
	const status = overrides.status ?? 'active'
	return {
		id,
		user_id: overrides.user_id ?? 'user-1',
		source_id: sourceId,
		source_repo_id: `repo-${sourceId}`,
		session_branch: `sessions/${id}`,
		source_branch: 'main',
		base_commit: `base-${id}`,
		source_root: '/',
		conversation_id: `conversation-${id}`,
		status,
		expires_at: status === 'active' ? null : '2026-05-12T00:00:00.000Z',
		last_checkpoint_at: null,
		last_checkpoint_commit: `checkpoint-${id}`,
		last_check_run_id: `check-${id}`,
		last_check_tree_hash: `tree-${id}`,
		created_at: '2026-04-28T00:00:00.000Z',
		updated_at: overrides.updated_at ?? '2026-04-28T00:00:00.000Z',
	}
}

function createSource(sourceId = 'source-1') {
	return {
		id: sourceId,
		user_id: 'user-1',
		entity_kind: 'package' as const,
		entity_id: 'package-1',
		repo_id: `repo-${sourceId}`,
		published_commit: 'commit-published',
		indexed_commit: 'commit-indexed',
		manifest_path: 'package.json',
		source_root: '/',
		last_external_check_at: null,
		created_at: '2026-04-28T00:00:00.000Z',
		updated_at: '2026-04-28T00:00:00.000Z',
	}
}

function mockSourceAndPackage() {
	mockModule.getEntitySourceByIdForUser.mockImplementation(
		async (_db: D1Database, input: { id: string; userId: string }) =>
			input.userId === 'user-1' ? createSource(input.id) : null,
	)
	mockModule.getSavedPackageById.mockResolvedValue({
		id: 'package-1',
		userId: 'user-1',
		name: '@user/demo',
		kodyId: 'demo',
		description: 'Demo package',
		tags: [],
		searchText: null,
		sourceId: 'source-1',
		hasApp: false,
		hidden: false,
		createdAt: '2026-04-28T00:00:00.000Z',
		updatedAt: '2026-04-28T00:00:00.000Z',
	})
}

test('repo_list_sessions defaults to active sessions for the signed-in user', async () => {
	resetMocks()
	mockModule.listRepoSessionsByUser.mockResolvedValue([
		createSession({
			id: 'session-active',
			status: 'active',
			updated_at: '2026-04-28T00:03:00.000Z',
		}),
		createSession({
			id: 'session-published',
			status: 'published',
			updated_at: '2026-04-28T00:02:00.000Z',
		}),
		createSession({
			id: 'session-other-user',
			user_id: 'other-user',
			status: 'active',
			updated_at: '2026-04-28T00:01:00.000Z',
		}),
	])
	mockSourceAndPackage()

	const result = await repoListSessionsCapability.handler({}, createContext())

	expect(mockModule.listRepoSessionsByUser).toHaveBeenCalledWith({}, 'user-1')
	expect(result.sessions).toHaveLength(1)
	expect(result.sessions[0]).toMatchObject({
		id: 'session-active',
		source_id: 'source-1',
		entity_type: 'package',
		status: 'active',
		expires_at: null,
		session_branch: 'sessions/session-active',
		source_branch: 'main',
		resolved_target: {
			kind: 'package',
			source_id: 'source-1',
			package_id: 'package-1',
			kody_id: 'demo',
			name: '@user/demo',
		},
	})
})

test('repo_list_sessions status all includes inactive sessions', async () => {
	resetMocks()
	mockModule.listRepoSessionsByUser.mockResolvedValue([
		createSession({ id: 'session-active', status: 'active' }),
		createSession({ id: 'session-published', status: 'published' }),
		createSession({ id: 'session-discarded', status: 'discarded' }),
	])
	mockSourceAndPackage()

	const result = await repoListSessionsCapability.handler(
		{ status: 'all' },
		createContext(),
	)

	expect(result.sessions.map((session) => session.status)).toEqual([
		'active',
		'published',
		'discarded',
	])
	expect(result.sessions[1]?.expires_at).toBe('2026-05-12T00:00:00.000Z')
})

test('repo_list_sessions does not return rows for another user even if storage is malformed', async () => {
	resetMocks()
	mockModule.listRepoSessionsByUser.mockResolvedValue([
		createSession({ id: 'session-other-user', user_id: 'other-user' }),
	])
	mockSourceAndPackage()

	const result = await repoListSessionsCapability.handler({}, createContext())

	expect(result.sessions).toEqual([])
	expect(mockModule.getEntitySourceByIdForUser).not.toHaveBeenCalled()
})

test('repo_list_sessions supports source_id narrowing and limit', async () => {
	resetMocks()
	mockModule.listRepoSessionsBySource.mockResolvedValue([
		createSession({
			id: 'session-source-new',
			source_id: 'source-2',
			updated_at: '2026-04-28T00:02:00.000Z',
		}),
		createSession({
			id: 'session-source-old',
			source_id: 'source-2',
			updated_at: '2026-04-28T00:01:00.000Z',
		}),
	])
	mockSourceAndPackage()

	const result = await repoListSessionsCapability.handler(
		{ source_id: 'source-2', limit: 1 },
		createContext(),
	)

	expect(mockModule.listRepoSessionsBySource).toHaveBeenCalledWith(
		{},
		{ userId: 'user-1', sourceId: 'source-2' },
	)
	expect(mockModule.listRepoSessionsByUser).not.toHaveBeenCalled()
	expect(result.sessions.map((session) => session.id)).toEqual([
		'session-source-new',
	])
})

test('repo_list_sessions applies limit after dropping sessions with missing sources', async () => {
	resetMocks()
	mockModule.listRepoSessionsByUser.mockResolvedValue([
		createSession({
			id: 'session-missing-source',
			source_id: 'source-missing',
			updated_at: '2026-04-28T00:03:00.000Z',
		}),
		createSession({
			id: 'session-valid',
			source_id: 'source-1',
			updated_at: '2026-04-28T00:02:00.000Z',
		}),
	])
	mockModule.getEntitySourceByIdForUser.mockImplementation(
		async (_db: D1Database, input: { id: string; userId: string }) =>
			input.id === 'source-missing' || input.userId !== 'user-1'
				? null
				: createSource(input.id),
	)
	mockModule.getSavedPackageById.mockResolvedValue({
		id: 'package-1',
		userId: 'user-1',
		name: '@user/demo',
		kodyId: 'demo',
		description: 'Demo package',
		tags: [],
		searchText: null,
		sourceId: 'source-1',
		hasApp: false,
		hidden: false,
		createdAt: '2026-04-28T00:00:00.000Z',
		updatedAt: '2026-04-28T00:00:00.000Z',
	})

	const result = await repoListSessionsCapability.handler(
		{ limit: 1 },
		createContext(),
	)

	expect(result.sessions.map((session) => session.id)).toEqual([
		'session-valid',
	])
	expect(mockModule.getEntitySourceByIdForUser).toHaveBeenCalledTimes(2)
})
