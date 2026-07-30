import { expect, test, vi } from 'vitest'
import { McpCallerError } from '#mcp/caller-error.ts'
import { createMcpCallerContext } from '#mcp/context.ts'
import { isEntitlementLimitError } from '#worker/entitlements/errors.ts'
import { planLimits } from '#worker/entitlements/plans.ts'
import { createStableUserIdFromEmail } from '#worker/user-id.ts'
import { buildSourceRecoveryProblemMessage } from '#worker/repo/source-safety-policy.ts'
import { repoOpenSessionInputSchema } from './repo-shared.ts'

const mockModule = vi.hoisted(() => ({
	getActiveRepoSessionByConversation: vi.fn(),
	getEntitySourceByIdForUser: vi.fn(),
	getSavedPackageByKodyId: vi.fn(),
	repoSessionRpc: vi.fn(),
}))

vi.mock('#worker/repo/repo-sessions.ts', () => ({
	getActiveRepoSessionByConversation: (...args: Array<unknown>) =>
		mockModule.getActiveRepoSessionByConversation(...args),
}))

vi.mock('#worker/repo/entity-sources.ts', () => ({
	getEntitySourceByIdForUser: (...args: Array<unknown>) =>
		mockModule.getEntitySourceByIdForUser(...args),
}))

vi.mock('#worker/package-registry/repo.ts', () => ({
	getSavedPackageByKodyId: (...args: Array<unknown>) =>
		mockModule.getSavedPackageByKodyId(...args),
}))

vi.mock('#worker/repo/repo-session-do.ts', () => ({
	repoSessionRpc: (...args: Array<unknown>) =>
		mockModule.repoSessionRpc(...args),
}))

const { repoOpenSessionCapability } = await import('./repo-open-session.ts')

function createEntitlementsDatabase(input: {
	users: Array<{ email: string; plan: string | null; stable_user_id: string }>
	repoSessionCount: number
}) {
	return {
		prepare(query: string) {
			return {
				bind(...params: Array<unknown>) {
					return {
						async first<T>() {
							if (query.includes('SELECT plan, stripe_plan FROM users')) {
								const email = params[0]
								const stableUserId = params[1]
								if (
									typeof email !== 'string' ||
									typeof stableUserId !== 'string'
								) {
									return null as T | null
								}
								const user = input.users.find(
									(row) =>
										row.email === email && row.stable_user_id === stableUserId,
								)
								return (user ? { plan: user.plan } : null) as T | null
							}
							if (
								query.includes('FROM repo_sessions') &&
								query.includes('status =')
							) {
								return { count: input.repoSessionCount } as T
							}
							throw new Error(`Unsupported first query: ${query}`)
						},
					}
				},
			}
		},
	} as unknown as D1Database
}

function createRepoRpc(overrides?: Partial<Record<string, unknown>>) {
	return {
		openSession: vi.fn(),
		getSessionInfo: vi.fn(),
		...overrides,
	}
}

function createPackageSourceRow(userId: string) {
	return {
		id: 'source-package-1',
		user_id: userId,
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

function createSavedPackageRow(userId: string) {
	return {
		id: 'package-1',
		userId,
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

function createOpenSessionResult() {
	return {
		id: 'session-new',
		source_id: 'source-package-1',
		source_root: '/',
		base_commit: 'commit-package-1',
		session_branch: 'sessions/session-new',
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
	}
}

function resetMocks() {
	mockModule.getActiveRepoSessionByConversation.mockReset()
	mockModule.getEntitySourceByIdForUser.mockReset()
	mockModule.getSavedPackageByKodyId.mockReset()
	mockModule.repoSessionRpc.mockReset()
}

test('repo target accepts camelCase aliases for its snake_case fields', () => {
	// Agents guess `kodyId` / `packageId` often enough that the schema
	// normalizes both spellings instead of failing the round trip.
	expect(
		repoOpenSessionInputSchema.parse({
			target: { kind: 'package', kodyId: 'triage-github-pr' },
		}).target,
	).toEqual({ kind: 'package', kody_id: 'triage-github-pr' })
	expect(
		repoOpenSessionInputSchema.parse({
			target: { kind: 'package', packageId: 'package-1' },
		}).target,
	).toEqual({ kind: 'package', package_id: 'package-1' })
	expect(
		repoOpenSessionInputSchema.parse({
			target: { kind: 'package', kody_id: 'triage-github-pr' },
		}).target,
	).toEqual({ kind: 'package', kody_id: 'triage-github-pr' })
})

test('repo_open_session maps published HEAD mismatch to McpCallerError', async () => {
	resetMocks()
	const email = 'head-mismatch@example.com'
	const userId = await createStableUserIdFromEmail(email)
	const env = {
		APP_DB: createEntitlementsDatabase({
			users: [{ email, plan: 'pro', stable_user_id: userId }],
			repoSessionCount: 0,
		}),
	} as Env
	const ctx = {
		env,
		callerContext: createMcpCallerContext({
			baseUrl: 'https://heykody.dev',
			user: {
				userId,
				email,
				displayName: 'Head Mismatch User',
			},
		}),
	}
	const source = createPackageSourceRow(userId)
	mockModule.getActiveRepoSessionByConversation.mockResolvedValueOnce(null)
	mockModule.getSavedPackageByKodyId.mockResolvedValueOnce(
		createSavedPackageRow(userId),
	)
	mockModule.getEntitySourceByIdForUser.mockResolvedValueOnce(source)
	const openRpc = createRepoRpc()
	openRpc.openSession.mockRejectedValueOnce(
		new Error(
			buildSourceRecoveryProblemMessage({
				source,
				operation: 'repo_open_session',
				reason: `artifact source repo "${source.repo_id}" default branch HEAD "commit-unpublished" does not match published commit "${source.published_commit}"`,
			}),
		),
	)
	mockModule.repoSessionRpc.mockReturnValue(openRpc)

	const error = await repoOpenSessionCapability
		.handler(
			{
				target: { kind: 'package', kody_id: 'triage-github-pr' },
			},
			ctx,
		)
		.then(
			() => null,
			(thrown: unknown) => thrown,
		)

	expect(error).toBeInstanceOf(McpCallerError)
	expect(error).toMatchObject({
		message: expect.stringContaining('package_publish_external_push'),
	})
	expect(openRpc.openSession).toHaveBeenCalled()
})

test('repo_open_session enforces the repo sessions entitlement for plan users opening a new session', async () => {
	resetMocks()
	const email = 'planned@example.com'
	const userId = await createStableUserIdFromEmail(email)
	const limit = planLimits.pro.maxRepoSessions
	if (limit === null) {
		throw new Error('Expected a numeric pro repo session limit.')
	}
	const env = {
		APP_DB: createEntitlementsDatabase({
			users: [{ email, plan: 'pro', stable_user_id: userId }],
			repoSessionCount: limit,
		}),
	} as Env
	const ctx = {
		env,
		callerContext: createMcpCallerContext({
			baseUrl: 'https://heykody.dev',
			user: {
				userId,
				email,
				displayName: 'Planned User',
			},
		}),
	}
	mockModule.getActiveRepoSessionByConversation.mockResolvedValueOnce(null)
	mockModule.getSavedPackageByKodyId.mockResolvedValueOnce(
		createSavedPackageRow(userId),
	)
	mockModule.getEntitySourceByIdForUser.mockResolvedValueOnce(
		createPackageSourceRow(userId),
	)
	const openRpc = createRepoRpc()
	mockModule.repoSessionRpc.mockReturnValue(openRpc)

	const error = await repoOpenSessionCapability
		.handler(
			{
				target: { kind: 'package', kody_id: 'triage-github-pr' },
				conversation_id: 'conversation-1',
			},
			ctx,
		)
		.then(
			() => null,
			(thrown: unknown) => thrown,
		)

	if (!isEntitlementLimitError(error)) {
		throw new Error('Expected an EntitlementLimitError from repo_open_session.')
	}
	expect(error.details).toMatchObject({
		code: 'entitlement_limit_exceeded',
		resource: 'repo_sessions',
		plan: 'pro',
		limit,
		current: limit,
	})
	expect(openRpc.openSession).not.toHaveBeenCalled()
})

test('repo_open_session resumes an existing active session without enforcing the repo sessions entitlement', async () => {
	resetMocks()
	const email = 'planned@example.com'
	const userId = await createStableUserIdFromEmail(email)
	const limit = planLimits.pro.maxRepoSessions
	if (limit === null) {
		throw new Error('Expected a numeric pro repo session limit.')
	}
	const env = {
		APP_DB: createEntitlementsDatabase({
			users: [{ email, plan: 'pro', stable_user_id: userId }],
			repoSessionCount: limit,
		}),
	} as Env
	const ctx = {
		env,
		callerContext: createMcpCallerContext({
			baseUrl: 'https://heykody.dev',
			user: {
				userId,
				email,
				displayName: 'Planned User',
			},
		}),
	}
	mockModule.getActiveRepoSessionByConversation.mockResolvedValueOnce({
		id: 'session-existing',
		source_id: 'source-package-1',
	})
	mockModule.getSavedPackageByKodyId.mockResolvedValueOnce(
		createSavedPackageRow(userId),
	)
	mockModule.getEntitySourceByIdForUser.mockResolvedValueOnce(
		createPackageSourceRow(userId),
	)
	const resumeRpc = createRepoRpc()
	resumeRpc.getSessionInfo.mockResolvedValueOnce({
		...createOpenSessionResult(),
		id: 'session-existing',
	})
	mockModule.repoSessionRpc.mockReturnValue(resumeRpc)

	const resumed = await repoOpenSessionCapability.handler(
		{
			target: { kind: 'package', kody_id: 'triage-github-pr' },
			conversation_id: 'conversation-1',
		},
		ctx,
	)

	expect(resumed.id).toBe('session-existing')
	expect(resumeRpc.getSessionInfo).toHaveBeenCalledWith({
		sessionId: 'session-existing',
		userId,
	})
	expect(resumeRpc.openSession).not.toHaveBeenCalled()
})

test('repo_open_session allows below-max usage and denies at the max plan ceiling', async () => {
	resetMocks()
	const email = 'max@example.com'
	const userId = await createStableUserIdFromEmail(email)
	const maxLimit = planLimits.max.maxRepoSessions
	const belowMaxEnv = {
		APP_DB: createEntitlementsDatabase({
			users: [{ email, plan: 'max', stable_user_id: userId }],
			repoSessionCount: planLimits.pro.maxRepoSessions + 1,
		}),
	} as Env
	const belowMaxCtx = {
		env: belowMaxEnv,
		callerContext: createMcpCallerContext({
			baseUrl: 'https://heykody.dev',
			user: {
				userId,
				email,
				displayName: 'Max User',
			},
		}),
	}
	mockModule.getActiveRepoSessionByConversation.mockResolvedValueOnce(null)
	mockModule.getSavedPackageByKodyId.mockResolvedValueOnce(
		createSavedPackageRow(userId),
	)
	mockModule.getEntitySourceByIdForUser.mockResolvedValueOnce(
		createPackageSourceRow(userId),
	)
	const belowMaxRpc = createRepoRpc()
	belowMaxRpc.openSession.mockResolvedValueOnce(createOpenSessionResult())
	mockModule.repoSessionRpc.mockReturnValue(belowMaxRpc)

	const opened = await repoOpenSessionCapability.handler(
		{
			target: { kind: 'package', kody_id: 'triage-github-pr' },
		},
		belowMaxCtx,
	)
	expect(opened.id).toBe('session-new')
	expect(belowMaxRpc.openSession).toHaveBeenCalled()

	resetMocks()
	const atCeilingEnv = {
		APP_DB: createEntitlementsDatabase({
			users: [{ email, plan: 'max', stable_user_id: userId }],
			repoSessionCount: maxLimit,
		}),
	} as Env
	const atCeilingCtx = {
		env: atCeilingEnv,
		callerContext: createMcpCallerContext({
			baseUrl: 'https://heykody.dev',
			user: {
				userId,
				email,
				displayName: 'Max User',
			},
		}),
	}
	mockModule.getActiveRepoSessionByConversation.mockResolvedValueOnce(null)
	mockModule.getSavedPackageByKodyId.mockResolvedValueOnce(
		createSavedPackageRow(userId),
	)
	mockModule.getEntitySourceByIdForUser.mockResolvedValueOnce(
		createPackageSourceRow(userId),
	)
	const deniedRpc = createRepoRpc()
	mockModule.repoSessionRpc.mockReturnValue(deniedRpc)

	const error = await repoOpenSessionCapability
		.handler(
			{
				target: { kind: 'package', kody_id: 'triage-github-pr' },
				conversation_id: 'conversation-max',
			},
			atCeilingCtx,
		)
		.then(
			() => null,
			(thrown: unknown) => thrown,
		)
	if (!isEntitlementLimitError(error)) {
		throw new Error(
			'Expected an EntitlementLimitError at the max repo session ceiling.',
		)
	}
	expect(error.details).toMatchObject({
		code: 'entitlement_limit_exceeded',
		resource: 'repo_sessions',
		plan: 'max',
		limit: maxLimit,
		current: maxLimit,
	})
	expect(deniedRpc.openSession).not.toHaveBeenCalled()
})
