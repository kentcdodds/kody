import { expect, test, vi } from 'vitest'
import { consoleWarn } from '#worker/test-support/console-spies.ts'
import {
	desiredKitTagKeys,
	kitFactsFromUserRow,
	kitLifecycleTagNames,
	maybeSyncKitSubscriber,
	syncExistingKitSubscriber,
} from '#worker/kit/subscriber-sync.ts'

const tagCatalog = [
	{ id: 11, name: kitLifecycleTagNames.signedUp },
	{ id: 12, name: kitLifecycleTagNames.verified },
	{ id: 13, name: kitLifecycleTagNames.agentConnected },
	{ id: 14, name: kitLifecycleTagNames.activated },
	{ id: 15, name: kitLifecycleTagNames.standard },
	{ id: 16, name: kitLifecycleTagNames.pro },
]

function kitFetchImpl(input: {
	subscriberId?: number | null
	calls?: Array<{ url: string; method: string; body: unknown }>
}) {
	const calls = input.calls ?? []
	const fetchImpl = async (request: RequestInfo | URL, init?: RequestInit) => {
		const url = String(request)
		const method = init?.method ?? 'GET'
		const body = init?.body ? JSON.parse(String(init.body)) : null
		calls.push({ url, method, body })
		if (url.includes('/subscribers?email_address=')) {
			if (input.subscriberId == null) {
				return Response.json({ subscribers: [] })
			}
			return Response.json({
				subscribers: [
					{ id: input.subscriberId, email_address: 'ada@example.com' },
				],
			})
		}
		if (url.endsWith('/tags') || url.includes('/tags?')) {
			return Response.json({ tags: tagCatalog })
		}
		if (
			url.includes('/tags/') &&
			url.includes('/subscribers') &&
			method === 'POST'
		) {
			return Response.json(
				{ subscriber: { id: input.subscriberId } },
				{ status: 201 },
			)
		}
		if (
			url.includes('/subscribers/') &&
			url.includes('/tags/') &&
			method === 'DELETE'
		) {
			return new Response(null, { status: 204 })
		}
		throw new Error(`Unexpected Kit call: ${method} ${url}`)
	}
	return { calls, fetchImpl: fetchImpl as typeof fetch }
}

test('kitFactsFromUserRow maps activation and paid-plan columns', () => {
	expect(
		kitFactsFromUserRow({
			email_verified_at: null,
			first_mcp_connected_at: null,
			first_saved_package_at: null,
			stripe_plan: null,
		}),
	).toEqual({
		signedUp: true,
		verified: false,
		agentConnected: false,
		activated: false,
		paidPlan: null,
	})
	expect(
		desiredKitTagKeys(
			kitFactsFromUserRow({
				email_verified_at: '2026-08-01T00:00:00.000Z',
				first_mcp_connected_at: '2026-08-02T00:00:00.000Z',
				first_saved_package_at: '2026-08-03T00:00:00.000Z',
				stripe_plan: 'pro',
			}),
		),
	).toEqual(['signedUp', 'verified', 'agentConnected', 'activated', 'pro'])
})

test('syncExistingKitSubscriber skips missing subscribers and never creates them', async () => {
	const { calls, fetchImpl } = kitFetchImpl({ subscriberId: null })
	expect(
		await syncExistingKitSubscriber({
			apiKey: 'key',
			email: 'new@example.com',
			facts: kitFactsFromUserRow({}),
			fetchImpl,
		}),
	).toEqual({ synced: false, reason: 'not_found' })
	expect(calls).toHaveLength(1)
	expect(calls[0]?.url).toContain('/subscribers?email_address=')
	expect(calls.some((call) => call.method === 'POST')).toBe(false)
})

test('syncExistingKitSubscriber adds lifecycle tags and removes paid tags on cancel', async () => {
	const { calls, fetchImpl } = kitFetchImpl({ subscriberId: 9 })
	expect(
		await syncExistingKitSubscriber({
			apiKey: 'key',
			email: 'ada@example.com',
			facts: {
				signedUp: true,
				verified: true,
				agentConnected: false,
				activated: false,
				paidPlan: null,
			},
			fetchImpl,
		}),
	).toEqual({ synced: true, subscriberId: 9 })
	const added = calls.filter(
		(call) => call.method === 'POST' && call.url.includes('/tags/'),
	)
	expect(added.map((call) => call.url)).toEqual([
		'https://api.kit.com/v4/tags/11/subscribers',
		'https://api.kit.com/v4/tags/12/subscribers',
	])
	const removed = calls.filter((call) => call.method === 'DELETE')
	expect(removed.map((call) => call.url)).toEqual([
		'https://api.kit.com/v4/subscribers/9/tags/15',
		'https://api.kit.com/v4/subscribers/9/tags/16',
	])
	expect(
		calls.some((call) => call.url === 'https://api.kit.com/v4/subscribers'),
	).toBe(false)
})

test('maybeSyncKitSubscriber no-ops without Kit config and swallows failures', async () => {
	consoleWarn.mockImplementation(() => {})
	const idleFetch = vi.fn()
	await maybeSyncKitSubscriber({
		env: {},
		email: 'ada@example.com',
		facts: kitFactsFromUserRow({}),
		fetchImpl: idleFetch,
	})
	expect(idleFetch).not.toHaveBeenCalled()

	await maybeSyncKitSubscriber({
		env: { KIT_API_KEY: 'key', KIT_SIGNED_UP_TAG_ID: 'nope' },
		email: 'ada@example.com',
		facts: kitFactsFromUserRow({}),
		fetchImpl: idleFetch,
	})
	expect(idleFetch).not.toHaveBeenCalled()
	expect(consoleWarn).toHaveBeenCalledWith(
		'Skipping Kit subscriber sync: KIT_SIGNED_UP_TAG_ID is invalid.',
	)

	consoleWarn.mockClear()
	const failingFetch = vi.fn(async () =>
		Response.json({ errors: ['boom'] }, { status: 500 }),
	)
	await maybeSyncKitSubscriber({
		env: { KIT_API_KEY: 'key' },
		email: 'ada@example.com',
		facts: kitFactsFromUserRow({}),
		fetchImpl: failingFetch as typeof fetch,
	})
	expect(failingFetch).toHaveBeenCalled()
	expect(consoleWarn).toHaveBeenCalledWith(
		'Failed to sync Kit subscriber:',
		expect.any(Error),
	)
})
