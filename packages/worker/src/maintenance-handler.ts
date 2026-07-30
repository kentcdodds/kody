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

function timingSafeEqualDigests(
	left: ArrayBuffer,
	right: ArrayBuffer,
): boolean {
	if (left.byteLength !== right.byteLength) return false
	const subtleWithTiming = crypto.subtle as SubtleCrypto & {
		timingSafeEqual?: (a: BufferSource, b: BufferSource) => boolean
	}
	// Workers expose timingSafeEqual on subtle; Node unit tests do not.
	if (typeof subtleWithTiming.timingSafeEqual === 'function') {
		return subtleWithTiming.timingSafeEqual(left, right)
	}
	const a = new Uint8Array(left)
	const b = new Uint8Array(right)
	let diff = 0
	for (let index = 0; index < a.length; index += 1) {
		diff |= a[index]! ^ b[index]!
	}
	return diff === 0
}

/**
 * Constant-time bearer compare: SHA-256 both sides, then compare digests so
 * length differences do not leak via short-circuit string compares.
 */
export async function timingSafeEqualString(
	left: string,
	right: string,
): Promise<boolean> {
	const encoder = new TextEncoder()
	const [leftDigest, rightDigest] = await Promise.all([
		crypto.subtle.digest('SHA-256', encoder.encode(left)),
		crypto.subtle.digest('SHA-256', encoder.encode(right)),
	])
	return timingSafeEqualDigests(leftDigest, rightDigest)
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

	const bearer = readBearerToken(input.request)
	if (bearer === null || !(await timingSafeEqualString(bearer, secret))) {
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
