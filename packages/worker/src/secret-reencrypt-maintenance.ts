import {
	handleSecretMaintenanceRequest,
	MaintenanceFailureError,
} from './maintenance-handler.ts'
import { reencryptLegacySecretCiphertexts } from './mcp/secrets/reencrypt.ts'

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function failure(message: string) {
	return new MaintenanceFailureError(message, {})
}

async function readJsonObject(
	request: Request,
): Promise<Record<string, unknown>> {
	const text = await request.text()
	if (text.trim() === '') return {}
	let value: unknown
	try {
		value = JSON.parse(text)
	} catch {
		throw failure('Request body must be a JSON object')
	}
	if (!isRecord(value)) throw failure('Request body must be a JSON object')
	return value
}

function parseDryRun(value: unknown) {
	if (value === undefined) return false
	if (typeof value !== 'boolean') throw failure('dryRun must be a boolean')
	return value
}

function parseMaxRows(value: unknown) {
	if (value === undefined) return undefined
	if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
		throw failure('maxRows must be a positive integer')
	}
	return value
}

function parseRequestOptions(body: Record<string, unknown>) {
	const allowed = new Set(['dryRun', 'maxRows'])
	for (const key of Object.keys(body)) {
		if (!allowed.has(key)) throw failure(`unknown request field: ${key}`)
	}
	return {
		dryRun: parseDryRun(body['dryRun']),
		maxRows: parseMaxRows(body['maxRows']),
	}
}

export async function handleSecretReencryptRequest(
	request: Request,
	env: Env,
): Promise<Response> {
	return handleSecretMaintenanceRequest({
		request,
		secret: env.CAPABILITY_REINDEX_SECRET,
		notConfiguredMessage: 'Secret re-encryption is not configured',
		run: async () => {
			const options = parseRequestOptions(await readJsonObject(request))
			return reencryptLegacySecretCiphertexts({
				env,
				...options,
			})
		},
	})
}
