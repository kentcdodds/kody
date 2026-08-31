import { expect, test } from 'vitest'
import { createCommunityTrustApiPostHandler } from './community-trust.ts'

const env = { APP_DB: {} as D1Database } as Env

test('community trust POST returns 410 gone', async () => {
	const handler = createCommunityTrustApiPostHandler(env)
	const response = await handler.handler({
		request: new Request('https://example.com/community/listing-1/trust.json', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ trusted: true }),
		}),
		params: { listingId: 'listing-1' },
		url: new URL('https://example.com/community/listing-1/trust.json'),
	} as never)

	expect(response.status).toBe(410)
	expect(await response.json()).toEqual({
		ok: false,
		error: 'Trusted listings have been removed.',
	})
})
