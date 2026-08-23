import { expect, test } from 'vitest'
import { discardUnreadRequestBody } from './request-body.ts'

test('discardUnreadRequestBody drains unread teed bodies and no-ops when already consumed', async () => {
	const unread = new Request('http://example.com/auth/github', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ intent: 'start' }),
	})
	const parsed = await unread.clone().json()
	expect(parsed).toEqual({ intent: 'start' })
	expect(unread.bodyUsed).toBe(false)
	await discardUnreadRequestBody(unread)
	expect(unread.bodyUsed).toBe(true)

	const consumed = new Request('http://example.com/auth/github', {
		method: 'POST',
		body: JSON.stringify({ intent: 'start' }),
	})
	await consumed.json()
	await discardUnreadRequestBody(consumed)
	expect(consumed.bodyUsed).toBe(true)
})
