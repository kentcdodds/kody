import { expect, test } from 'vitest'
import { handleSecretMaintenanceRequest } from './maintenance-handler.ts'

function createRequest(
	input: { method?: string; authorization?: string; path?: string } = {},
) {
	return new Request(`http://localhost${input.path ?? '/__maintenance/test'}`, {
		method: input.method ?? 'POST',
		headers:
			input.authorization === undefined
				? undefined
				: { Authorization: input.authorization },
	})
}

test('handleSecretMaintenanceRequest enforces auth and reports maintenance results', async () => {
	let runCount = 0
	const run = async () => {
		runCount += 1
		return { upserted: runCount }
	}

	const methodResponse = await handleSecretMaintenanceRequest({
		request: createRequest({ method: 'GET', authorization: 'Bearer secret' }),
		secret: 'secret',
		notConfiguredMessage: 'Not configured',
		run,
	})

	expect(methodResponse.status).toBe(405)
	expect(await methodResponse.text()).toBe('Method Not Allowed')

	const configurationResponse = await handleSecretMaintenanceRequest({
		request: createRequest({ authorization: 'Bearer secret' }),
		secret: ' ',
		notConfiguredMessage: 'Not configured',
		run,
	})

	expect(configurationResponse.status).toBe(503)
	expect(await configurationResponse.text()).toBe('Not configured')

	for (const authorization of [undefined, 'Bearer wrong']) {
		const response = await handleSecretMaintenanceRequest({
			request: createRequest({ authorization }),
			secret: 'secret',
			notConfiguredMessage: 'Not configured',
			run,
		})

		expect(response.status).toBe(401)
		expect(await response.text()).toBe('Unauthorized')
	}

	expect(runCount).toBe(0)

	const successResponse = await handleSecretMaintenanceRequest({
		request: createRequest({ authorization: 'Bearer secret' }),
		secret: ' secret ',
		notConfiguredMessage: 'Not configured',
		run,
	})

	expect(successResponse.status).toBe(200)
	await expect(successResponse.json()).resolves.toEqual({
		ok: true,
		upserted: 1,
	})
	expect(runCount).toBe(1)

	const errorResponse = await handleSecretMaintenanceRequest({
		request: createRequest({ authorization: 'Bearer secret' }),
		secret: 'secret',
		notConfiguredMessage: 'Not configured',
		run: async () => {
			throw new Error('boom')
		},
	})

	expect(errorResponse.status).toBe(500)
	await expect(errorResponse.json()).resolves.toEqual({
		ok: false,
		error: 'boom',
	})
})
