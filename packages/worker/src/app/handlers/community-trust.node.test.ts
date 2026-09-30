import { expect, test } from 'vitest'
import { createCommunityTrustApiPostHandler } from './community-trust.ts'

const env = { APP_DB: {} as D1Database } as Env

test('community trust POST returns 410 gone', async () => {
	const handler = createCommunityTrustApiPostHandler(env)
	const response = await handler.handler()

	expect(response.status).toBe(410)
	expect(await response.json()).toEqual({
		ok: false,
		error: 'Trusted listings have been removed.',
	})
})
