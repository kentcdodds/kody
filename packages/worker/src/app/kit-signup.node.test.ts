import { expect, test, vi } from 'vitest'
import {
	type KitSignupError,
	maybeTagKitSubscriberOnSignup,
	resolveKitSignedUpTagId,
	tagExistingKitSubscriberOnSignup,
} from '#app/kit-signup.ts'

test('resolveKitSignedUpTagId parses overrides and rejects junk', () => {
	expect(resolveKitSignedUpTagId(undefined)).toBe(21252175)
	expect(resolveKitSignedUpTagId(' 99 ')).toBe(99)
	expect(resolveKitSignedUpTagId('nope')).toBeNull()
})

test('tagExistingKitSubscriberOnSignup tags existing subscribers only', async () => {
	const calls: Array<{ url: string; method: string; body: unknown }> = []
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
	expect(calls.map((call) => call.method)).toEqual(['GET', 'POST'])
	expect(
		calls.some(
			(call) =>
				call.method === 'POST' &&
				call.url === 'https://api.kit.com/v4/subscribers',
		),
	).toBe(false)
})

test('tagExistingKitSubscriberOnSignup skips emails not in Kit', async () => {
	const calls: Array<{ url: string; method: string }> = []
	const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = String(input)
		const method = init?.method ?? 'GET'
		calls.push({ url, method })
		if (url.includes('/subscribers?email_address=')) {
			return Response.json({ subscribers: [] }, { status: 200 })
		}
		throw new Error(`Unexpected Kit call: ${method} ${url}`)
	}

	const result = await tagExistingKitSubscriberOnSignup({
		apiKey: 'key',
		email: 'new@example.com',
		tagId: 123,
		fetchImpl: fetchImpl as typeof fetch,
	})
	expect(result).toEqual({ tagged: false, reason: 'not_found' })
	expect(calls).toHaveLength(1)
})

test('tagExistingKitSubscriberOnSignup classifies client failures', async () => {
	const fetchImpl = vi.fn(async () =>
		Response.json({ errors: ['invalid'] }, { status: 422 }),
	)
	await expect(
		tagExistingKitSubscriberOnSignup({
			apiKey: 'key',
			email: 'ada@example.com',
			fetchImpl: fetchImpl as typeof fetch,
		}),
	).rejects.toMatchObject({
		name: 'KitSignupError',
		kind: 'client',
		status: 422,
	} satisfies Partial<KitSignupError>)
})

test('maybeTagKitSubscriberOnSignup no-ops without an API key', async () => {
	const fetchImpl = vi.fn()
	await maybeTagKitSubscriberOnSignup({
		env: {},
		email: 'ada@example.com',
		fetchImpl: fetchImpl as typeof fetch,
	})
	expect(fetchImpl).not.toHaveBeenCalled()
})

test('maybeTagKitSubscriberOnSignup swallows Kit failures', async () => {
	const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
	const fetchImpl = vi.fn(async () =>
		Response.json({ errors: ['boom'] }, { status: 500 }),
	)
	await maybeTagKitSubscriberOnSignup({
		env: { KIT_API_KEY: 'key' },
		email: 'ada@example.com',
		fetchImpl: fetchImpl as typeof fetch,
	})
	expect(fetchImpl).toHaveBeenCalled()
	expect(warn).toHaveBeenCalled()
	warn.mockRestore()
})
