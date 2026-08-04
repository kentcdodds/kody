import { expect, test } from 'vitest'
import { reconcileArtifactsPushes } from '#worker/jobs/reconcile-artifacts-pushes.ts'

test('reconcileArtifactsPushes skips plain repo entity_sources', async () => {
	const calls: Array<string> = []
	const env = {
		APP_DB: {
			prepare(query: string) {
				return {
					bind(...params: Array<unknown>) {
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
