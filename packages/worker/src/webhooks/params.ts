import { type WebhookExportParams } from './types.ts'

export function parseWebhookJsonBody(text: string): unknown | null {
	const trimmed = text.trim()
	if (!trimmed) return null
	try {
		return JSON.parse(trimmed) as unknown
	} catch {
		return null
	}
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
