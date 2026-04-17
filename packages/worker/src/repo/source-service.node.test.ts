import { expect, test } from 'vitest'

const { ensureEntitySource } = await import('./source-service.ts')

test('ensureEntitySource fails closed when durable persistence is required without Artifacts REST credentials', async () => {
	const db = {
		prepare() {
			return {
				bind() {
					return {
						async first() {
							return null
						},
					}
				},
			}
		},
	} as unknown as D1Database

	await expect(
		ensureEntitySource({
			db,
			env: { APP_DB: db } as Env,
			userId: 'user-1',
			entityKind: 'app',
			entityId: 'app-1',
			sourceRoot: '/',
			requirePersistence: true,
		}),
	).rejects.toThrow(
		'Repo-backed source persistence requires CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN.',
	)
})
