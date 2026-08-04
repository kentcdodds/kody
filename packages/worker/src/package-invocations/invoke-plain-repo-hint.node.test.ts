import { expect, test } from 'vitest'
import {
	buildPlainRepoPromotionErrorMessage,
	plainRepoPromotionNotice,
	findPlainRepoPromotionHint,
} from '#worker/repo/user-repos.ts'

test('buildPlainRepoPromotionErrorMessage points at repo_promote_to_package', () => {
	const message = buildPlainRepoPromotionErrorMessage('my-notes')
	expect(message).toContain(plainRepoPromotionNotice)
	expect(message).toContain('repo_promote_to_package')
})

test('findPlainRepoPromotionHint matches bare names from scoped package lookups', async () => {
	const db = {
		prepare(query: string) {
			return {
				bind(...params: Array<unknown>) {
					return {
						async first<T>() {
							if (
								query.includes('FROM user_repos') &&
								query.includes('name = ?')
							) {
								expect(params[1]).toBe('notes')
								return {
									id: 'repo-1',
									user_id: 'user-1',
									name: 'notes',
									description: null,
									created_at: '2026-01-01T00:00:00.000Z',
									updated_at: '2026-01-01T00:00:00.000Z',
								} as T
							}
							return null as T
						},
					}
				},
			}
		},
	} as unknown as D1Database

	const row = await findPlainRepoPromotionHint(db, {
		userId: 'user-1',
		packageIdOrKodyId: '@alice/notes',
	})
	expect(row?.name).toBe('notes')
})
