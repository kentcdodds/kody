import { expect, test, vi } from 'vitest'

const mockModule = vi.hoisted(() => ({
	resolveArtifactSourceHead: vi.fn(),
	publishFromExternalRef: vi.fn(),
}))

vi.mock('#worker/repo/artifacts.ts', () => ({
	resolveArtifactSourceHead: (...args: Array<unknown>) =>
		mockModule.resolveArtifactSourceHead(...args),
}))

vi.mock('#worker/repo/repo-session-rpc.ts', () => ({
	repoSessionRpc: () => ({
		publishFromExternalRef: (...args: Array<unknown>) =>
			mockModule.publishFromExternalRef(...args),
	}),
}))

const { reconcileArtifactsPushes } =
	await import('#worker/jobs/reconcile-artifacts-pushes.ts')

test('reconcileArtifactsPushes skips plain repo entity_sources', async () => {
	const calls: Array<string> = []
	const env = {
		APP_DB: {
			prepare(query: string) {
				return {
					bind(..._params: Array<unknown>) {
						return {
							async all<T>() {
								if (query.includes('FROM entity_sources')) {
									calls.push('list')
									return {
										results: [
											{
												id: 'source-repo',
												user_id: 'user-1',
												entity_kind: 'repo',
												entity_id: 'repo-1',
												repo_id: 'repo-repo-1',
												published_commit: null,
												indexed_commit: null,
												manifest_path: 'package.json',
												source_root: '/',
												last_external_check_at: null,
												external_check_until: null,
												created_at: '2026-01-01T00:00:00.000Z',
												updated_at: '2026-01-01T00:00:00.000Z',
											},
										],
									} as T
								}
								throw new Error(`Unexpected all: ${query}`)
							},
							async run() {
								if (query.includes('UPDATE entity_sources')) {
									calls.push('update')
								}
								return { meta: { changes: 1 } }
							},
						}
					},
				}
			},
		},
	} as unknown as Env

	const result = await reconcileArtifactsPushes({
		env,
		baseUrl: 'https://kody.test',
		now: new Date('2026-08-04T12:00:00.000Z'),
		batchSize: 10,
		staleAfterMinutes: 0,
		timeBudgetMs: 1000,
	})

	expect(result.checked).toBe(0)
	expect(calls).not.toContain('update')
})

test('reconcileArtifactsPushes skips locked packages without calling publish', async () => {
	const calls: Array<string> = []
	mockModule.publishFromExternalRef.mockReset()
	mockModule.resolveArtifactSourceHead.mockResolvedValue({
		branch: 'main',
		commit: 'commit-new',
	})
	const env = {
		APP_DB: {
			prepare(query: string) {
				return {
					bind(..._params: Array<unknown>) {
						return {
							async all<T>() {
								if (query.includes('FROM entity_sources')) {
									calls.push('list')
									return {
										results: [
											{
												id: 'source-package',
												user_id: 'user-1',
												entity_kind: 'package',
												entity_id: 'pkg-1',
												repo_id: 'repo-pkg-1',
												published_commit: 'commit-old',
												indexed_commit: null,
												manifest_path: 'package.json',
												source_root: '/',
												last_external_check_at: null,
												external_check_until: '2026-08-28T13:00:00.000Z',
												created_at: '2026-01-01T00:00:00.000Z',
												updated_at: '2026-01-01T00:00:00.000Z',
											},
										],
									} as T
								}
								throw new Error(`Unexpected all: ${query}`)
							},
							async first<T>() {
								if (query.includes('locked_at')) {
									calls.push('locked_at')
									return { locked_at: '2026-08-28T12:00:00.000Z' } as T
								}
								throw new Error(`Unexpected first: ${query}`)
							},
							async run() {
								if (query.includes('UPDATE entity_sources')) {
									calls.push('update')
								}
								return { meta: { changes: 1 } }
							},
						}
					},
				}
			},
		},
	} as unknown as Env

	const result = await reconcileArtifactsPushes({
		env,
		baseUrl: 'https://kody.test',
		now: new Date('2026-08-04T12:00:00.000Z'),
		batchSize: 10,
		staleAfterMinutes: 0,
		timeBudgetMs: 1000,
	})

	expect(result.checked).toBe(1)
	expect(result.lockedSkipped).toBe(1)
	expect(result.published).toBe(0)
	expect(calls).toContain('locked_at')
	expect(calls).toContain('update')
	expect(mockModule.publishFromExternalRef).not.toHaveBeenCalled()
})
