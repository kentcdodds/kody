import { getErrorMessage } from '@kody-internal/shared/error-message.ts'

type MaintenanceResult = Record<string, unknown> & { ok?: never }

export class MaintenanceFailureError extends Error {
	readonly result: MaintenanceResult

	constructor(message: string, result: MaintenanceResult) {
		super(message)
		this.name = 'MaintenanceFailureError'
		this.result = result
	}
}

type SecretMaintenanceRequestInput = {
	request: Request
	secret: string | null | undefined
	notConfiguredMessage: string
	run: () => Promise<MaintenanceResult>
}

function readBearerToken(request: Request) {
	const auth = request.headers.get('Authorization')?.trim()
	return auth?.startsWith('Bearer ')
		? auth.slice('Bearer '.length).trim()
		: null
}

export async function handleSecretMaintenanceRequest(
	input: SecretMaintenanceRequestInput,
): Promise<Response> {
	if (input.request.method !== 'POST') {
		return new Response('Method Not Allowed', { status: 405 })
	}

	const secret = input.secret?.trim()
	if (!secret) {
		return new Response(input.notConfiguredMessage, { status: 503 })
	}

	if (readBearerToken(input.request) !== secret) {
		return new Response('Unauthorized', { status: 401 })
	}

	try {
		const result = await input.run()
		return Response.json({ ...result, ok: true })
	} catch (error) {
		if (error instanceof MaintenanceFailureError) {
			return Response.json(
				{ ...error.result, ok: false, error: error.message },
				{ status: 500 },
			)
		}
		return Response.json(
			{ ok: false, error: getErrorMessage(error) },
			{ status: 500 },
		)
	}
}
