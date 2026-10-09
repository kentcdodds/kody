import {
	maxRestorableTextColumnBytes,
	utf8ByteLength,
} from '@kody-internal/shared/backup-restore-safety.ts'

/**
 * Replay-cache ceiling for the ledger's `response_json`. The ledger lives in
 * the per-user RunLog Durable Object now, but the bound is kept at the
 * restore-safe D1 column ceiling it inherited: replay payloads above it were
 * never stored, so the DO rows stay small and export sections stay pageable.
 * Oversized terminal responses are stored as NULL; idempotent duplicates of
 * those invocations get the existing `idempotency_response_unavailable`
 * outcome instead of a replay.
 */
export const maxStoredInvocationResponseJsonBytes = maxRestorableTextColumnBytes

export type PackageInvocationStoredResponse = {
	status: number
	body: Record<string, unknown>
}

/**
 * Serialize a terminal response for the RunLog DO ledger's replay cache,
 * dropping it when oversized.
 */
export function boundedResponseJson(
	response: PackageInvocationStoredResponse,
): string | null {
	const responseJson = JSON.stringify({
		status: response.status,
		body: response.body,
	})
	if (utf8ByteLength(responseJson) > maxStoredInvocationResponseJsonBytes) {
		return null
	}
	return responseJson
}

export function parseStoredResponse(
	value: string | null,
): PackageInvocationStoredResponse | null {
	if (!value) return null
	try {
		const parsed = JSON.parse(value) as unknown
		if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
			return null
		}
		const record = parsed as Record<string, unknown>
		const status = record['status']
		const body = record['body']
		if (
			typeof status !== 'number' ||
			!Number.isInteger(status) ||
			!body ||
			typeof body !== 'object' ||
			Array.isArray(body)
		) {
			return null
		}
		return {
			status,
			body: body as Record<string, unknown>,
		}
	} catch {
		return null
	}
}
