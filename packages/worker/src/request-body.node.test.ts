import { expect, test } from 'vitest'
import { discardUnreadRequestBody } from './request-body.ts'

test('discardUnreadRequestBody drains a teed original after the clone is read', async () => {
	const request = new Request('http://example.com/auth/github', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ intent: 'start' }),
	})
	const parsed = await request.clone().json()
	expect(parsed).toEqual({ intent: 'start' })
	expect(request.bodyUsed).toBe(false)

	await discardUnreadRequestBody(request)
	expect(request.bodyUsed).toBe(true)
})

test('discardUnreadRequestBody is a no-op when the original is already consumed', async () => {
	const request = new Request('http://example.com/auth/github', {
		method: 'POST',
		body: JSON.stringify({ intent: 'start' }),
	})
	await request.json()
	await discardUnreadRequestBody(request)
	expect(request.bodyUsed).toBe(true)
})
