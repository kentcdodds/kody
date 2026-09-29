import { expect, test } from 'vitest'
import {
	handleSecretMaintenanceRequest,
	MaintenanceClientError,
} from './maintenance-handler.ts'

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
	const handle = (
		request: Request,
		secret = 'secret',
		runner: () => Promise<Record<string, unknown>> = run,
	) =>
		handleSecretMaintenanceRequest({
			request,
			secret,
			notConfiguredMessage: 'Not configured',
			run: runner,
		})
	const authorized = () => createRequest({ authorization: 'Bearer secret' })

	const rejections: Array<[Request, string, number, string]> = [
		[
			createRequest({ method: 'GET', authorization: 'Bearer secret' }),
			'secret',
			405,
			'Method Not Allowed',
		],
		[authorized(), ' ', 503, 'Not configured'],
		[createRequest(), 'secret', 401, 'Unauthorized'],
		[
			createRequest({ authorization: 'Bearer wrong' }),
			'secret',
			401,
			'Unauthorized',
		],
	]
	const rejected = []
	for (const [request, secret] of rejections) {
		const response = await handle(request, secret)
		rejected.push([response.status, await response.text()])
	}
	expect(rejected).toEqual(
		rejections.map(([, , status, text]) => [status, text]),
	)
	expect(runCount).toBe(0)

	const successResponse = await handle(authorized(), ' secret ')
	expect(successResponse.status).toBe(200)
	await expect(successResponse.json()).resolves.toEqual({
		ok: true,
		upserted: 1,
	})
	expect(runCount).toBe(1)

	const failures: Array<[Error, number, string]> = [
		[new Error('boom'), 500, 'boom'],
		[new MaintenanceClientError('bad cursor'), 400, 'bad cursor'],
	]
	for (const [error, status, message] of failures) {
		const response = await handle(authorized(), 'secret', async () => {
			throw error
		})
		expect(response.status).toBe(status)
		await expect(response.json()).resolves.toEqual({
			ok: false,
			error: message,
		})
	}
})
