import { expect, test, vi } from 'vitest'
import {
	type KitSignupError,
	maybeTagKitSubscriberOnSignup,
	tagExistingKitSubscriberOnSignup,
} from '#app/kit-signup.ts'
import { consoleWarn } from '#worker/test-support/console-spies.ts'

test('tagExistingKitSubscriberOnSignup tags existing subscribers, skips unknowns, and classifies client failures', async () => {
	const existingCalls: Array<{ url: string; method: string; body: unknown }> =
		[]
	const existingFetchImpl = async (
		input: RequestInfo | URL,
		init?: RequestInit,
	) => {
		const url = String(input)
		const method = init?.method ?? 'GET'
		const body = init?.body ? JSON.parse(String(init.body)) : null
		existingCalls.push({ url, method, body })
		if (url.includes('/subscribers?email_address=')) {
			return Response.json(
				{
					subscribers: [
						{
							id: 9,
							email_address: 'ada@example.com',
							first_name: 'Ada',
						},
					],
				},
				{ status: 200 },
			)
		}
		if (url.includes('/tags/123/subscribers') && method === 'POST') {
			return Response.json(
				{ subscriber: { id: 9, email_address: 'ada@example.com' } },
				{ status: 201 },
			)
		}
		throw new Error(`Unexpected Kit call: ${method} ${url}`)
	}

	const tagged = await tagExistingKitSubscriberOnSignup({
		apiKey: 'key',
		email: 'ada@example.com',
		tagId: 123,
		fetchImpl: existingFetchImpl as typeof fetch,
	})
	expect(tagged).toEqual({ tagged: true, subscriberId: 9 })
	expect(existingCalls.map((call) => call.method)).toEqual(['GET', 'POST'])
	expect(
		existingCalls.some(
			(call) =>
				call.method === 'POST' &&
				call.url === 'https://api.kit.com/v4/subscribers',
		),
	).toBe(false)

	const missingCalls: Array<{ url: string; method: string }> = []
	const missingFetchImpl = async (
		input: RequestInfo | URL,
		init?: RequestInit,
	) => {
		const url = String(input)
		const method = init?.method ?? 'GET'
		missingCalls.push({ url, method })
		if (url.includes('/subscribers?email_address=')) {
			return Response.json({ subscribers: [] }, { status: 200 })
		}
		throw new Error(`Unexpected Kit call: ${method} ${url}`)
	}
	expect(
		await tagExistingKitSubscriberOnSignup({
			apiKey: 'key',
			email: 'new@example.com',
			tagId: 123,
			fetchImpl: missingFetchImpl as typeof fetch,
		}),
	).toEqual({ tagged: false, reason: 'not_found' })
	expect(missingCalls).toHaveLength(1)

	const failingFetch = vi.fn(async () =>
		Response.json({ errors: ['invalid'] }, { status: 422 }),
	)
	await expect(
		tagExistingKitSubscriberOnSignup({
			apiKey: 'key',
			email: 'ada@example.com',
			fetchImpl: failingFetch as typeof fetch,
		}),
	).rejects.toMatchObject({
		name: 'KitSignupError',
		kind: 'client',
		status: 422,
	} satisfies Partial<KitSignupError>)
})

test('maybeTagKitSubscriberOnSignup no-ops without Kit config and swallows failures', async () => {
	consoleWarn.mockImplementation(() => {})
	const idleFetch = vi.fn()
	await maybeTagKitSubscriberOnSignup({
		env: {},
		email: 'ada@example.com',
		fetchImpl: idleFetch as typeof fetch,
	})
	expect(idleFetch).not.toHaveBeenCalled()
	expect(consoleWarn).not.toHaveBeenCalled()

	await maybeTagKitSubscriberOnSignup({
		env: { KIT_API_KEY: 'key', KIT_SIGNED_UP_TAG_ID: 'nope' },
		email: 'ada@example.com',
		fetchImpl: idleFetch as typeof fetch,
	})
	expect(idleFetch).not.toHaveBeenCalled()
	expect(consoleWarn).toHaveBeenCalledWith(
		'Skipping Kit signed-up tagging: KIT_SIGNED_UP_TAG_ID is invalid.',
	)

	consoleWarn.mockClear()
	const failingFetch = vi.fn(async () =>
		Response.json({ errors: ['boom'] }, { status: 500 }),
	)
	await maybeTagKitSubscriberOnSignup({
		env: { KIT_API_KEY: 'key' },
		email: 'ada@example.com',
		fetchImpl: failingFetch as typeof fetch,
	})
	expect(failingFetch).toHaveBeenCalled()
	expect(consoleWarn).toHaveBeenCalledWith(
		'Failed to tag Kit subscriber on signup:',
		expect.any(Error),
	)
})
