import {
	webhookIdempotencyKeyHeader,
	type WebhookExportParams,
} from './types.ts'

export function parseWebhookJsonBody(text: string): unknown | null {
	const trimmed = text.trim()
	if (!trimmed) return null
	try {
		return JSON.parse(trimmed) as unknown
	} catch {
		return null
	}
}

export function isWebhookJsonObject(
	value: unknown,
): value is Record<string, unknown> {
	return value !== null && typeof value === 'object' && !Array.isArray(value)
}

export type WebhookParamsModeResolution =
	| { ok: true; params: Record<string, unknown> }
	| { ok: false; code: 'invalid_params' }

/**
 * `inputMode: "params"` first argument. The parsed JSON object is the export
 * argument. When that object has a `params` property that is itself a JSON
 * object, the platform unwraps it so invoke-token callers can POST the same
 * `{ params, idempotencyKey }` envelope.
 */
export function resolveWebhookParamsModeFirstArg(
	json: unknown,
): WebhookParamsModeResolution {
	if (!isWebhookJsonObject(json)) {
		return { ok: false, code: 'invalid_params' }
	}
	const nested = json['params']
	if (isWebhookJsonObject(nested)) {
		return { ok: true, params: nested }
	}
	return { ok: true, params: json }
}

export function readWebhookCallerIdempotencyKey(input: {
	request: Request
	json: unknown
	allowBodyKey: boolean
}): string | null {
	const header = input.request.headers.get(webhookIdempotencyKeyHeader)?.trim()
	if (header) return header
	if (!input.allowBodyKey || !isWebhookJsonObject(input.json)) return null
	const key = input.json['idempotencyKey']
	return typeof key === 'string' && key.trim() ? key.trim() : null
}

export function buildWebhookCallerIdempotencyHashParams(input: {
	json: unknown
	bodyText: string
}): Record<string, unknown> {
	if (isWebhookJsonObject(input.json)) return input.json
	return { body: input.bodyText }
}

export function buildWebhookExportParams(input: {
	packageKodyId: string
	webhookName: string
	request: Request
	bodyText: string
	receivedAt: string
	headers: Record<string, string>
}): WebhookExportParams {
	return {
		webhook: {
			packageKodyId: input.packageKodyId,
			name: input.webhookName,
			receivedAt: input.receivedAt,
		},
		request: {
			method: input.request.method,
			contentType: input.request.headers.get('content-type'),
			headers: input.headers,
			body: input.bodyText,
			json: parseWebhookJsonBody(input.bodyText),
		},
	}
}
