import { expect, test } from 'vitest'
import {
	DEFAULT_KIT_WAITLIST_TAG_ID,
	resolveKitWaitlistTagId,
	subscribeToKitWaitlist,
} from '#app/kit-waitlist.ts'

test('resolveKitWaitlistTagId defaults and validates overrides', () => {
	expect(resolveKitWaitlistTagId(undefined)).toBe(DEFAULT_KIT_WAITLIST_TAG_ID)
	expect(resolveKitWaitlistTagId('')).toBe(DEFAULT_KIT_WAITLIST_TAG_ID)
	expect(resolveKitWaitlistTagId(' 99 ')).toBe(99)
	expect(resolveKitWaitlistTagId('0')).toBeNull()
	expect(resolveKitWaitlistTagId('nope')).toBeNull()
})

test('subscribeToKitWaitlist creates then tags the subscriber', async () => {
	const calls: Array<{ url: string; body: unknown }> = []
	const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = String(input)
		const body = init?.body ? JSON.parse(String(init.body)) : null
		calls.push({ url, body })
		if (url.endsWith('/subscribers')) {
			return Response.json(
				{ subscriber: { id: 7, email_address: body.email_address } },
				{ status: 201 },
			)
		}
		return Response.json(
			{ subscriber: { id: 7, email_address: body.email_address } },
			{ status: 201 },
		)
	}

	const result = await subscribeToKitWaitlist({
		apiKey: 'key',
		email: 'ada@example.com',
		firstName: 'Ada',
		tagId: 123,
		fetchImpl: fetchImpl as typeof fetch,
	})

	expect(result).toEqual({ subscriberId: 7 })
	expect(calls).toEqual([
		{
			url: 'https://api.kit.com/v4/subscribers',
			body: { email_address: 'ada@example.com', first_name: 'Ada' },
		},
		{
			url: 'https://api.kit.com/v4/tags/123/subscribers',
			body: { email_address: 'ada@example.com' },
		},
	])
})
