import { expect, test, vi } from 'vitest'
import {
	DEFAULT_KIT_WAITLIST_TAG_ID,
	type KitWaitlistError,
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

test('subscribeToKitWaitlist creates new subscribers then tags them', async () => {
	const calls: Array<{ url: string; method: string; body: unknown }> = []
	const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = String(input)
		const method = init?.method ?? 'GET'
		const body = init?.body ? JSON.parse(String(init.body)) : null
		calls.push({ url, method, body })
		if (url.includes('/subscribers?email_address=')) {
			return Response.json({ subscribers: [] }, { status: 200 })
		}
		if (url.endsWith('/subscribers') && method === 'POST') {
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

	expect(result).toEqual({ subscriberId: 7, created: true })
	expect(calls).toEqual([
		{
			url: 'https://api.kit.com/v4/subscribers?email_address=ada%40example.com',
			method: 'GET',
			body: null,
		},
		{
			url: 'https://api.kit.com/v4/subscribers',
			method: 'POST',
			body: { email_address: 'ada@example.com', first_name: 'Ada' },
		},
		{
			url: 'https://api.kit.com/v4/tags/123/subscribers',
			method: 'POST',
			body: { email_address: 'ada@example.com' },
		},
	])
})

test('subscribeToKitWaitlist does not overwrite an existing first name', async () => {
	const calls: Array<{ url: string; method: string; body: unknown }> = []
	const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = String(input)
		const method = init?.method ?? 'GET'
		const body = init?.body ? JSON.parse(String(init.body)) : null
		calls.push({ url, method, body })
		if (url.includes('/subscribers?email_address=')) {
			return Response.json(
				{
					subscribers: [
						{
							id: 9,
							email_address: 'ada@example.com',
							first_name: 'Existing',
						},
					],
				},
				{ status: 200 },
			)
		}
		return Response.json(
			{ subscriber: { id: 9, email_address: 'ada@example.com' } },
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

	expect(result).toEqual({ subscriberId: 9, created: false })
	expect(calls).toEqual([
		{
			url: 'https://api.kit.com/v4/subscribers?email_address=ada%40example.com',
			method: 'GET',
			body: null,
		},
		{
			url: 'https://api.kit.com/v4/tags/123/subscribers',
			method: 'POST',
			body: { email_address: 'ada@example.com' },
		},
	])
})

test('subscribeToKitWaitlist classifies client failures', async () => {
	const fetchImpl = vi.fn(async () =>
		Response.json({ errors: ['invalid'] }, { status: 422 }),
	)
	await expect(
		subscribeToKitWaitlist({
			apiKey: 'key',
			email: 'ada@example.com',
			firstName: 'Ada',
			fetchImpl: fetchImpl as typeof fetch,
		}),
	).rejects.toMatchObject({
		name: 'KitWaitlistError',
		kind: 'client',
		status: 422,
	} satisfies Partial<KitWaitlistError>)
})
