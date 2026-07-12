import { expect, test, vi } from 'vitest'
import {
	type KitWaitlistError,
	resolveKitWaitlistSequenceId,
	resolveKitWaitlistTagId,
	subscribeToKitWaitlist,
} from '#app/kit-waitlist.ts'

test('subscribeToKitWaitlist enrolls new and existing subscribers', async () => {
	expect(resolveKitWaitlistTagId(' 99 ')).toBe(99)
	expect(resolveKitWaitlistTagId('nope')).toBeNull()
	expect(resolveKitWaitlistSequenceId('2823893')).toBe(2823893)
	expect(resolveKitWaitlistSequenceId('nope')).toBeNull()

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

	const created = await subscribeToKitWaitlist({
		apiKey: 'key',
		email: 'ada@example.com',
		firstName: 'Ada',
		tagId: 123,
		sequenceId: 456,
		fetchImpl: fetchImpl as typeof fetch,
	})
	expect(created).toEqual({ subscriberId: 7, created: true })
	expect(calls.map((call) => call.method)).toEqual([
		'GET',
		'POST',
		'POST',
		'POST',
	])

	calls.length = 0
	const existingFetchImpl = async (
		input: RequestInfo | URL,
		init?: RequestInit,
	) => {
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

	const existing = await subscribeToKitWaitlist({
		apiKey: 'key',
		email: 'ada@example.com',
		firstName: 'Ada',
		tagId: 123,
		sequenceId: 456,
		fetchImpl: existingFetchImpl as typeof fetch,
	})
	expect(existing).toEqual({ subscriberId: 9, created: false })
	expect(calls.map((call) => call.method)).toEqual(['GET', 'POST', 'POST'])
	expect(
		calls.some(
			(call) =>
				call.method === 'POST' &&
				call.url === 'https://api.kit.com/v4/subscribers',
		),
	).toBe(false)
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
