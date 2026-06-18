import { expect, test, vi } from 'vitest'
import {
	handleSecretMaintenanceRequest,
	readBearerToken,
} from './maintenance-handler.ts'

function createRequest(
	input: { method?: string; authorization?: string } = {},
) {
	return new Request('http://localhost/__maintenance/test', {
		method: input.method ?? 'POST',
		headers:
			input.authorization === undefined
				? undefined
				: { Authorization: input.authorization },
	})
}

test('readBearerToken extracts trimmed bearer credentials', () => {
	expect(
		readBearerToken(createRequest({ authorization: ' Bearer secret ' })),
	).toBe('secret')
	expect(
		readBearerToken(createRequest({ authorization: 'Basic secret' })),
	).toBe(null)
})

test('handleSecretMaintenanceRequest rejects non-POST requests', async () => {
	const response = await handleSecretMaintenanceRequest({
		request: createRequest({ method: 'GET', authorization: 'Bearer secret' }),
		secret: 'secret',
		notConfiguredMessage: 'Not configured',
		run: async () => ({ upserted: 1 }),
	})

	expect(response.status).toBe(405)
	expect(await response.text()).toBe('Method Not Allowed')
})

test('handleSecretMaintenanceRequest rejects missing configuration', async () => {
	const response = await handleSecretMaintenanceRequest({
		request: createRequest({ authorization: 'Bearer secret' }),
		secret: ' ',
		notConfiguredMessage: 'Not configured',
		run: async () => ({ upserted: 1 }),
	})

	expect(response.status).toBe(503)
	expect(await response.text()).toBe('Not configured')
})

test('handleSecretMaintenanceRequest rejects missing or wrong bearer tokens', async () => {
	for (const authorization of [undefined, 'Bearer wrong']) {
		const response = await handleSecretMaintenanceRequest({
			request: createRequest({ authorization }),
			secret: 'secret',
			notConfiguredMessage: 'Not configured',
			run: async () => ({ upserted: 1 }),
		})

		expect(response.status).toBe(401)
		expect(await response.text()).toBe('Unauthorized')
	}
})

test('handleSecretMaintenanceRequest returns the upsert count', async () => {
	const run = vi.fn(async () => ({ upserted: 3 }))

	const response = await handleSecretMaintenanceRequest({
		request: createRequest({ authorization: 'Bearer secret' }),
		secret: ' secret ',
		notConfiguredMessage: 'Not configured',
		run,
	})

	expect(response.status).toBe(200)
	await expect(response.json()).resolves.toEqual({ ok: true, upserted: 3 })
	expect(run).toHaveBeenCalledOnce()
})

test('handleSecretMaintenanceRequest returns error responses from failures', async () => {
	const response = await handleSecretMaintenanceRequest({
		request: createRequest({ authorization: 'Bearer secret' }),
		secret: 'secret',
		notConfiguredMessage: 'Not configured',
		run: async () => {
			throw new Error('boom')
		},
	})

	expect(response.status).toBe(500)
	await expect(response.json()).resolves.toEqual({ ok: false, error: 'boom' })
})
