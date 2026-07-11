import { expect, test, vi } from 'vitest'
import {
	consoleWarn,
	silenceExpectedConsoleWarns,
} from '#worker/test-support/console-spies.ts'

const mockModule = vi.hoisted(() => ({
	listEntitySourcesForExternalReconcile: vi.fn(),
	updateEntitySource: vi.fn(async () => true),
	resolveArtifactSourceHead: vi.fn(),
	revokeStaleArtifactsTokens: vi.fn(async () => ({ checked: 0, revoked: 0 })),
	publishFromExternalRef: vi.fn(),
	repoSessionRpc: vi.fn(() => ({
		publishFromExternalRef: mockModule.publishFromExternalRef,
	})),
}))

vi.mock('#worker/repo/entity-sources.ts', () => ({
	listEntitySourcesForExternalReconcile: (...args: Array<unknown>) =>
		mockModule.listEntitySourcesForExternalReconcile(...args),
	updateEntitySource: (...args: Array<unknown>) =>
		mockModule.updateEntitySource(...args),
}))

vi.mock('#worker/repo/artifacts.ts', () => ({
	resolveArtifactSourceHead: (...args: Array<unknown>) =>
		mockModule.resolveArtifactSourceHead(...args),
}))

vi.mock('#worker/repo/artifacts-tokens.ts', () => ({
	revokeStaleArtifactsTokens: (...args: Array<unknown>) =>
		mockModule.revokeStaleArtifactsTokens(...args),
}))

vi.mock('#worker/repo/repo-session-do.ts', () => ({
	repoSessionRpc: (...args: Array<unknown>) =>
		mockModule.repoSessionRpc(...args),
}))

const { reconcileArtifactsPushes } =
	await import('./reconcile-artifacts-pushes.ts')

function source(overrides: Record<string, unknown> = {}) {
	return {
		id: 'source-1',
		user_id: 'user-1',
		entity_kind: 'package',
		entity_id: 'package-1',
		repo_id: 'repo-1',
		published_commit: 'commit-old',
		indexed_commit: null,
		manifest_path: 'package.json',
		source_root: '/',
		last_external_check_at: null,
		created_at: '2026-05-04T00:00:00.000Z',
		updated_at: '2026-05-04T00:00:00.000Z',
		...overrides,
	}
}

test('publishes changed Artifacts HEADs and records reconcile checks', async () => {
	mockModule.listEntitySourcesForExternalReconcile.mockResolvedValue([
		source(),
		source({
			id: 'source-2',
			repo_id: 'repo-2',
			published_commit: 'commit-current',
		}),
	])
	mockModule.resolveArtifactSourceHead
		.mockResolvedValueOnce({ branch: 'main', commit: 'commit-new' })
		.mockResolvedValueOnce({ branch: 'main', commit: 'commit-current' })
	mockModule.publishFromExternalRef.mockResolvedValueOnce({
		status: 'published',
		published_commit: 'commit-new',
		previous_commit: 'commit-old',
		manifest: {},
		checks: [],
	})

	const result = await reconcileArtifactsPushes({
		env: { APP_DB: {} } as Env,
		baseUrl: 'https://kody.test',
		now: new Date('2026-05-04T02:00:00.000Z'),
		staleAfterMinutes: 10,
	})

	expect(mockModule.listEntitySourcesForExternalReconcile).toHaveBeenCalledWith(
		expect.anything(),
		{
			before: '2026-05-04T01:50:00.000Z',
			limit: 50,
		},
	)
	expect(result).toEqual({
		checked: 2,
		published: 1,
		alreadyPublished: 1,
		missingHead: 0,
		checksFailed: 0,
		notFastForward: 0,
		errors: 0,
		tokenCleanupErrors: 0,
		tokensRevoked: 0,
		batches: 1,
		budgetExhausted: false,
	})
	expect(mockModule.publishFromExternalRef).toHaveBeenCalledWith(
		expect.objectContaining({
			sourceId: 'source-1',
			newCommit: 'commit-new',
			allowForce: false,
		}),
	)
	expect(mockModule.updateEntitySource).toHaveBeenCalledTimes(2)

	mockModule.listEntitySourcesForExternalReconcile.mockResolvedValue([source()])
	mockModule.resolveArtifactSourceHead.mockResolvedValue({
		branch: 'main',
		commit: null,
	})

	const missingHead = await reconcileArtifactsPushes({
		env: { APP_DB: {} } as Env,
		baseUrl: 'https://kody.test',
		now: new Date('2026-05-04T02:00:00.000Z'),
	})

	expect(missingHead).toEqual(
		expect.objectContaining({
			alreadyPublished: 0,
			missingHead: 1,
		}),
	)
	expect(mockModule.publishFromExternalRef).toHaveBeenCalledTimes(1)
})

test('reconcile records source checks and continues the batch when a source or its check write fails', async () => {
	consoleWarn.mockImplementation(() => {})
	mockModule.listEntitySourcesForExternalReconcile.mockResolvedValue([source()])
	mockModule.resolveArtifactSourceHead.mockRejectedValueOnce(new Error('boom'))

	const singleFailure = await reconcileArtifactsPushes({
		env: { APP_DB: {} } as Env,
		baseUrl: 'https://kody.test',
		now: new Date('2026-05-04T02:00:00.000Z'),
	})

	expect(singleFailure.errors).toBe(1)
	expect(consoleWarn).toHaveBeenCalledWith(
		'reconcile_artifacts_pushes source failed',
		expect.objectContaining({ sourceId: 'source-1' }),
	)
	expect(mockModule.updateEntitySource).toHaveBeenCalledWith(
		expect.anything(),
		{
			id: 'source-1',
			userId: 'user-1',
			lastExternalCheckAt: '2026-05-04T02:00:00.000Z',
		},
	)

	mockModule.resolveArtifactSourceHead.mockClear()
	mockModule.updateEntitySource.mockClear()
	mockModule.listEntitySourcesForExternalReconcile.mockResolvedValue([
		source(),
		source({
			id: 'source-2',
			repo_id: 'repo-2',
			published_commit: 'commit-current',
		}),
	])
	mockModule.resolveArtifactSourceHead
		.mockRejectedValueOnce(new Error('boom'))
		.mockResolvedValueOnce({ branch: 'main', commit: 'commit-current' })
	mockModule.updateEntitySource
		.mockRejectedValueOnce(new Error('d1 unavailable'))
		.mockResolvedValueOnce(true)

	const batchFailure = await reconcileArtifactsPushes({
		env: { APP_DB: {} } as Env,
		baseUrl: 'https://kody.test',
		now: new Date('2026-05-04T02:00:00.000Z'),
	})

	expect(batchFailure).toEqual({
		checked: 2,
		published: 0,
		alreadyPublished: 1,
		missingHead: 0,
		checksFailed: 0,
		notFastForward: 0,
		errors: 1,
		tokenCleanupErrors: 0,
		tokensRevoked: 0,
		batches: 1,
		budgetExhausted: false,
	})
	expect(mockModule.resolveArtifactSourceHead).toHaveBeenCalledTimes(2)
	expect(consoleWarn).toHaveBeenCalledWith(
		'reconcile_artifacts_pushes cursor update failed',
		expect.objectContaining({ sourceId: 'source-1' }),
	)
})

test('reconcile runs token cleanup in the 03:00 UTC window without blocking publish on cleanup failure', async () => {
	consoleWarn.mockImplementation(() => {})
	mockModule.listEntitySourcesForExternalReconcile.mockResolvedValue([source()])
	mockModule.resolveArtifactSourceHead.mockResolvedValue({
		branch: 'main',
		commit: 'commit-old',
	})
	mockModule.revokeStaleArtifactsTokens.mockResolvedValueOnce({
		checked: 3,
		revoked: 2,
	})

	const cleanupResult = await reconcileArtifactsPushes({
		env: { APP_DB: {} } as Env,
		baseUrl: 'https://kody.test',
		now: new Date('2026-05-04T03:02:00.000Z'),
	})

	expect(cleanupResult.tokensRevoked).toBe(2)
	expect(mockModule.revokeStaleArtifactsTokens).toHaveBeenCalledWith(
		expect.anything(),
		'repo-1',
		{ keepAfter: new Date('2026-05-04T03:02:00.000Z') },
	)

	mockModule.listEntitySourcesForExternalReconcile.mockResolvedValue([source()])
	mockModule.resolveArtifactSourceHead.mockResolvedValue({
		branch: 'main',
		commit: 'commit-new',
	})
	mockModule.revokeStaleArtifactsTokens.mockRejectedValueOnce(
		new Error('cleanup failed'),
	)
	mockModule.publishFromExternalRef.mockResolvedValueOnce({
		status: 'published',
		published_commit: 'commit-new',
		previous_commit: 'commit-old',
		manifest: {},
		checks: [],
	})

	const publishDespiteCleanupFailure = await reconcileArtifactsPushes({
		env: { APP_DB: {} } as Env,
		baseUrl: 'https://kody.test',
		now: new Date('2026-05-04T03:02:00.000Z'),
	})

	expect(publishDespiteCleanupFailure).toEqual(
		expect.objectContaining({
			published: 1,
			errors: 0,
			tokenCleanupErrors: 1,
		}),
	)
	expect(consoleWarn).toHaveBeenCalledWith(
		'reconcile_artifacts_pushes token cleanup failed',
		expect.objectContaining({ sourceId: 'source-1' }),
	)
	expect(mockModule.publishFromExternalRef).toHaveBeenCalledTimes(1)
})

test('reconcile drains multiple batches in one tick without DO work for unchanged heads', async () => {
	mockModule.listEntitySourcesForExternalReconcile.mockReset()
	mockModule.listEntitySourcesForExternalReconcile
		.mockResolvedValueOnce([
			source({ id: 'source-1', published_commit: 'commit-current' }),
			source({
				id: 'source-2',
				repo_id: 'repo-2',
				published_commit: 'commit-current',
			}),
		])
		.mockResolvedValueOnce([
			source({
				id: 'source-3',
				repo_id: 'repo-3',
				published_commit: 'commit-current',
			}),
		])
	mockModule.resolveArtifactSourceHead.mockReset()
	mockModule.resolveArtifactSourceHead.mockResolvedValue({
		branch: 'main',
		commit: 'commit-current',
	})
	mockModule.updateEntitySource.mockClear()
	mockModule.repoSessionRpc.mockClear()

	const result = await reconcileArtifactsPushes({
		env: { APP_DB: {} } as Env,
		baseUrl: 'https://kody.test',
		now: new Date('2026-05-04T02:00:00.000Z'),
		batchSize: 2,
	})

	expect(result).toEqual(
		expect.objectContaining({
			checked: 3,
			alreadyPublished: 3,
			batches: 2,
			budgetExhausted: false,
		}),
	)
	expect(
		mockModule.listEntitySourcesForExternalReconcile,
	).toHaveBeenCalledTimes(2)
	// Unchanged HEADs must only advance the cursor, never touch the DO.
	expect(mockModule.repoSessionRpc).not.toHaveBeenCalled()
	expect(mockModule.updateEntitySource).toHaveBeenCalledTimes(3)
})

test('reconcile stops between items once the time budget is exhausted', async () => {
	mockModule.listEntitySourcesForExternalReconcile.mockReset()
	mockModule.listEntitySourcesForExternalReconcile.mockResolvedValue([
		source({ id: 'source-1', published_commit: 'commit-current' }),
		source({
			id: 'source-2',
			repo_id: 'repo-2',
			published_commit: 'commit-current',
		}),
	])
	mockModule.resolveArtifactSourceHead.mockReset()
	mockModule.resolveArtifactSourceHead.mockResolvedValue({
		branch: 'main',
		commit: 'commit-current',
	})

	const result = await reconcileArtifactsPushes({
		env: { APP_DB: {} } as Env,
		baseUrl: 'https://kody.test',
		now: new Date('2026-05-04T02:00:00.000Z'),
		timeBudgetMs: 0,
	})

	expect(result).toEqual(
		expect.objectContaining({
			checked: 1,
			batches: 1,
			budgetExhausted: true,
		}),
	)
	expect(
		mockModule.listEntitySourcesForExternalReconcile,
	).toHaveBeenCalledTimes(1)
})

test('reconcile does not reprocess a source whose cursor write keeps failing', async () => {
	consoleWarn.mockImplementation(() => {})
	mockModule.listEntitySourcesForExternalReconcile.mockReset()
	mockModule.listEntitySourcesForExternalReconcile.mockResolvedValue([
		source({ id: 'source-1', published_commit: 'commit-current' }),
	])
	mockModule.resolveArtifactSourceHead.mockReset()
	mockModule.resolveArtifactSourceHead.mockResolvedValue({
		branch: 'main',
		commit: 'commit-current',
	})
	mockModule.updateEntitySource.mockReset()
	mockModule.updateEntitySource.mockRejectedValue(new Error('d1 unavailable'))

	const result = await reconcileArtifactsPushes({
		env: { APP_DB: {} } as Env,
		baseUrl: 'https://kody.test',
		now: new Date('2026-05-04T02:00:00.000Z'),
		batchSize: 1,
	})

	// The stale source stays selectable (its cursor write failed) but must be
	// processed at most once per tick instead of spinning until the budget.
	expect(result).toEqual(
		expect.objectContaining({
			checked: 1,
			errors: 1,
			batches: 1,
			budgetExhausted: false,
		}),
	)
	expect(
		mockModule.listEntitySourcesForExternalReconcile,
	).toHaveBeenCalledTimes(2)
	expect(consoleWarn).toHaveBeenCalledWith(
		'reconcile_artifacts_pushes cursor update failed',
		expect.objectContaining({ sourceId: 'source-1' }),
	)

	mockModule.updateEntitySource.mockReset()
	mockModule.updateEntitySource.mockResolvedValue(true)
})

test('head sources with failing cursor writes do not starve sources behind them within a tick', async () => {
	// Cursor-write failure warns are covered elsewhere; this test is about
	// keyset paging, so the warns are silenced without assertions.
	silenceExpectedConsoleWarns([
		'reconcile_artifacts_pushes cursor update failed',
		'reconcile_artifacts_pushes source failed',
	])
	// Simulated table: two head-of-queue sources whose cursor writes keep
	// failing, plus one healthy source ordered behind them.
	const rows = [
		source({
			id: 'source-a',
			published_commit: 'commit-current',
			created_at: '2026-05-04T00:00:00.000Z',
		}),
		source({
			id: 'source-b',
			repo_id: 'repo-2',
			published_commit: 'commit-current',
			created_at: '2026-05-04T00:01:00.000Z',
		}),
		source({
			id: 'source-c',
			repo_id: 'repo-3',
			published_commit: 'commit-current',
			created_at: '2026-05-04T00:02:00.000Z',
		}),
	]
	const checkedAt = new Map<string, string>()
	mockModule.listEntitySourcesForExternalReconcile.mockReset()
	// Emulate the real query: staleness filter, keyset `after` cursor, and the
	// stale ordering with id tie-break.
	mockModule.listEntitySourcesForExternalReconcile.mockImplementation(
		async (...args: Array<unknown>) => {
			const query = args[1] as {
				before: string
				limit: number
				after?: { staleOrderedAt: string; id: string }
			}
			return rows
				.map((row) => ({
					...row,
					last_external_check_at:
						checkedAt.get(row.id) ?? row.last_external_check_at,
				}))
				.filter(
					(row) =>
						row.last_external_check_at === null ||
						row.last_external_check_at < query.before,
				)
				.map((row) => ({
					row,
					key: row.last_external_check_at ?? row.created_at,
				}))
				.filter(
					({ row, key }) =>
						!query.after ||
						key > query.after.staleOrderedAt ||
						(key === query.after.staleOrderedAt && row.id > query.after.id),
				)
				.sort((a, b) =>
					a.key === b.key
						? a.row.id.localeCompare(b.row.id)
						: a.key.localeCompare(b.key),
				)
				.slice(0, query.limit)
				.map(({ row }) => row)
		},
	)
	mockModule.resolveArtifactSourceHead.mockReset()
	mockModule.resolveArtifactSourceHead.mockResolvedValue({
		branch: 'main',
		commit: 'commit-current',
	})
	mockModule.updateEntitySource.mockReset()
	mockModule.updateEntitySource.mockImplementation(
		async (...args: Array<unknown>) => {
			const update = args[1] as { id: string; lastExternalCheckAt: string }
			if (update.id !== 'source-c') throw new Error('d1 unavailable')
			checkedAt.set(update.id, update.lastExternalCheckAt)
			return true
		},
	)

	const result = await reconcileArtifactsPushes({
		env: { APP_DB: {} } as Env,
		baseUrl: 'https://kody.test',
		now: new Date('2026-05-04T02:00:00.000Z'),
		batchSize: 2,
	})

	// All three sources are reconciled in a single tick even though the first
	// batch's rows never leave the stale window.
	expect(result).toEqual(
		expect.objectContaining({
			checked: 3,
			alreadyPublished: 3,
			errors: 2,
			batches: 2,
			budgetExhausted: false,
		}),
	)
	expect(
		mockModule.listEntitySourcesForExternalReconcile,
	).toHaveBeenCalledTimes(2)
	// The second batch query pages past the failing head rows via the keyset.
	expect(
		mockModule.listEntitySourcesForExternalReconcile,
	).toHaveBeenNthCalledWith(2, expect.anything(), {
		before: '2026-05-04T01:55:00.000Z',
		limit: 2,
		after: { staleOrderedAt: '2026-05-04T00:01:00.000Z', id: 'source-b' },
	})
	// The healthy source's reconcile cursor is persisted.
	expect(checkedAt.get('source-c')).toBe('2026-05-04T02:00:00.000Z')

	mockModule.updateEntitySource.mockReset()
	mockModule.updateEntitySource.mockResolvedValue(true)
})
