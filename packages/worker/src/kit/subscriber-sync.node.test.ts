import { expect, test } from 'vitest'
import { http, HttpResponse } from 'msw'
import { consoleWarn } from '#worker/test-support/console-spies.ts'
import { createMswNodeServer } from '#worker/test-support/msw-node-server.ts'
import {
	desiredKitTagKeys,
	kitFactsFromUserRow,
	kitLifecycleTagNames,
	maybeSyncKitSubscriber,
	syncExistingKitSubscriber,
} from '#worker/kit/subscriber-sync.ts'

const kitApi = 'https://api.kit.com/v4'

const tagCatalog = [
	{ id: 11, name: kitLifecycleTagNames.signedUp },
	{ id: 12, name: kitLifecycleTagNames.verified },
	{ id: 13, name: kitLifecycleTagNames.agentConnected },
	{ id: 14, name: kitLifecycleTagNames.activated },
	{ id: 15, name: kitLifecycleTagNames.standard },
	{ id: 16, name: kitLifecycleTagNames.pro },
]

type KitCall = {
	url: string
	method: string
	body: unknown
	apiKey: string | null
}

type RecordedHttpRequest = {
	url: string
	method: string
	headers: { get(name: string): string | null }
	clone(): { json(): Promise<unknown> }
}

async function recordKitCall(
	request: RecordedHttpRequest,
	calls: Array<KitCall>,
) {
	calls.push({
		url: request.url,
		method: request.method,
		body:
			request.method === 'GET' || request.method === 'DELETE'
				? null
				: await request.clone().json(),
		apiKey: request.headers.get('X-Kit-Api-Key'),
	})
}

function kitHandlers(input: {
	subscriberId?: number | null
	calls: Array<KitCall>
}) {
	return [
		http.get(`${kitApi}/subscribers`, async ({ request }) => {
			await recordKitCall(request, input.calls)
			return HttpResponse.json({
				subscribers:
					input.subscriberId == null
						? []
						: [{ id: input.subscriberId, email_address: 'ada@example.com' }],
			})
		}),
		http.get(`${kitApi}/tags`, async ({ request }) => {
			await recordKitCall(request, input.calls)
			return HttpResponse.json({ tags: tagCatalog })
		}),
		http.post(`${kitApi}/tags/:tagId/subscribers`, async ({ request }) => {
			await recordKitCall(request, input.calls)
			return HttpResponse.json(
				{ subscriber: { id: input.subscriberId } },
				{ status: 201 },
			)
		}),
		http.delete(
			`${kitApi}/subscribers/:subscriberId/tags/:tagId`,
			async ({ request }) => {
				await recordKitCall(request, input.calls)
				return new HttpResponse(null, { status: 204 })
			},
		),
	]
}

test('syncExistingKitSubscriber adds lifecycle tags and removes paid tags on cancel', async () => {
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

	const calls: Array<KitCall> = []
	using _server = createMswNodeServer(kitHandlers({ subscriberId: 9, calls }))
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
		}),
	).toEqual({ synced: true, subscriberId: 9 })
	expect(calls.every((call) => call.apiKey === 'key')).toBe(true)
	const urls = (method: string) =>
		calls.filter((call) => call.method === method).map((call) => call.url)
	expect(urls('POST')).toEqual([
		`${kitApi}/tags/11/subscribers`,
		`${kitApi}/tags/12/subscribers`,
	])
	expect(
		calls.filter((call) => call.method === 'POST').map((call) => call.body),
	).toEqual([
		{ email_address: 'ada@example.com' },
		{ email_address: 'ada@example.com' },
	])
	expect(urls('DELETE')).toEqual([
		`${kitApi}/subscribers/9/tags/15`,
		`${kitApi}/subscribers/9/tags/16`,
	])
	expect(calls.some((call) => call.url === `${kitApi}/subscribers`)).toBe(false)
})

test('syncExistingKitSubscriber skips missing subscribers and never creates them', async () => {
	const calls: Array<KitCall> = []
	using _server = createMswNodeServer(
		kitHandlers({ subscriberId: null, calls }),
	)
	expect(
		await syncExistingKitSubscriber({
			apiKey: 'key',
			email: 'new@example.com',
			facts: kitFactsFromUserRow({}),
		}),
	).toEqual({ synced: false, reason: 'not_found' })
	expect(calls).toHaveLength(1)
	expect(calls[0]?.url).toContain('/subscribers?email_address=')
	expect(calls[0]?.apiKey).toBe('key')
	expect(calls.some((call) => call.method === 'POST')).toBe(false)
})

test('maybeSyncKitSubscriber no-ops without Kit config and swallows failures', async () => {
	consoleWarn.mockImplementation(() => {})
	type KitEnv = Parameters<typeof maybeSyncKitSubscriber>[0]['env']
	const sync = (env: Partial<KitEnv>) =>
		maybeSyncKitSubscriber({
			env: env as KitEnv,
			email: 'ada@example.com',
			facts: kitFactsFromUserRow({}),
		})
	using msw = createMswNodeServer()
	await sync({})
	await sync({ KIT_API_KEY: 'key', KIT_SIGNED_UP_TAG_ID: 'nope' })
	expect(consoleWarn).toHaveBeenCalledWith(
		'Skipping Kit subscriber sync: KIT_SIGNED_UP_TAG_ID is invalid.',
	)

	consoleWarn.mockClear()
	const failingCalls: Array<string> = []
	msw.use(
		http.get(`${kitApi}/subscribers`, ({ request }) => {
			failingCalls.push(request.url)
			return HttpResponse.json({ errors: ['boom'] }, { status: 500 })
		}),
	)
	await sync({ KIT_API_KEY: 'key' })
	expect(failingCalls.length).toBeGreaterThan(0)
	expect(consoleWarn).toHaveBeenCalledWith(
		'Failed to sync Kit subscriber:',
		expect.any(Error),
	)
})
