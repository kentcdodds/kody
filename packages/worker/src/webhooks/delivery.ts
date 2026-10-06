import { getAppBaseUrl } from '#worker/app-base-url.ts'
import { invokePackageExport } from '#worker/package-invocations/service.ts'
import { recordRunRecord } from '#worker/run-records/service.ts'
import { type RunRecordLogInput } from '#worker/run-records/types.ts'
import {
	type WebhookDeliveryOutcome,
	type WebhookEndpointRecord,
} from './types.ts'

export async function recordWebhookDelivery(input: {
	env: Env
	endpoint: Pick<
		WebhookEndpointRecord,
		'id' | 'userId' | 'packageId' | 'webhookName'
	>
	kodyId: string
	outcome: WebhookDeliveryOutcome
	httpStatus: number
	error?: string | null
	payloadBytes: number
	invocationId?: string
	/** Handler return value from the bound package export (bounded on finish). */
	result?: unknown
	startedAt: string
	/**
	 * Ingress receive time when it differs from `startedAt` (ack queue lag).
	 * Stored under metadata so Activity duration measures dispatch work, not
	 * provider→queue wait.
	 */
	receivedAt?: string
	/** Underlying package-invocation error code when the export failed. */
	invocationErrorCode?: string | null
	logs?: Array<RunRecordLogInput>
	waitUntil?: (promise: Promise<unknown>) => void
	requirePersistence?: boolean
	/** Platform-marked synthetic smoke test (interactive MCP only). */
	synthetic?: boolean
}) {
	const status = input.outcome === 'delivered' ? 'success' : 'error'
	const record = await recordRunRecord({
		env: input.env,
		userId: input.endpoint.userId,
		context: {
			surface: 'webhook',
			name: input.endpoint.webhookName,
			packageId: input.endpoint.packageId,
			kodyId: input.kodyId,
			invocationId: input.invocationId ?? crypto.randomUUID(),
			metadata: {
				endpointId: input.endpoint.id,
				httpStatus: input.httpStatus,
				payloadBytes: input.payloadBytes,
				outcome: input.outcome,
				...(input.receivedAt ? { receivedAt: input.receivedAt } : {}),
				...(input.invocationErrorCode
					? { invocationErrorCode: input.invocationErrorCode }
					: {}),
				...(input.synthetic === true ? { synthetic: true } : {}),
			},
		},
		status,
		error: input.error ?? undefined,
		result: input.result,
		logs: input.logs,
		startedAt: input.startedAt,
		waitUntil: input.waitUntil,
	})
	if (!record && input.requirePersistence) {
		throw new Error('Webhook delivery record was not persisted.')
	}
	return record
}

export function readWebhookInvocationResult(body: unknown): unknown {
	if (!body || typeof body !== 'object' || Array.isArray(body)) return undefined
	return (body as Record<string, unknown>)['result']
}

export function readWebhookInvocationError(body: unknown): {
	code: string | null
	message: string | null
} {
	if (!body || typeof body !== 'object' || Array.isArray(body)) {
		return { code: null, message: null }
	}
	const error = (body as Record<string, unknown>)['error']
	if (!error || typeof error !== 'object' || Array.isArray(error)) {
		return { code: null, message: null }
	}
	const record = error as Record<string, unknown>
	return {
		code: typeof record['code'] === 'string' ? record['code'] : null,
		message: typeof record['message'] === 'string' ? record['message'] : null,
	}
}

export function buildWebhookDispatchFailureLogs(input: {
	httpStatus: number
	body: unknown
	exhausted?: boolean
	attempts?: number
}): Array<RunRecordLogInput> {
	const invocationError = readWebhookInvocationError(input.body)
	const logs: Array<RunRecordLogInput> = [
		{
			level: 'error',
			message: input.exhausted
				? `Webhook dispatch gave up after ${input.attempts ?? 'max'} retries.`
				: `Webhook export invocation failed with HTTP ${input.httpStatus}.`,
		},
	]
	if (invocationError.code) {
		logs.push({
			level: 'error',
			message: `Invocation error code: ${invocationError.code}`,
			fields: {
				code: invocationError.code,
				...(invocationError.message ? { detail: invocationError.message } : {}),
			},
		})
	} else if (invocationError.message) {
		logs.push({
			level: 'error',
			message: invocationError.message,
		})
	}
	return logs
}

export async function dispatchWebhookInvocation(input: {
	env: Env
	baseUrl?: string
	endpoint: Pick<
		WebhookEndpointRecord,
		'id' | 'userId' | 'packageId' | 'webhookName'
	>
	packageKodyId: string
	exportName: string
	params: Record<string, unknown>
	idempotencyKey: string
	idempotencyParamsHash?: 'ignore'
	idempotencyHashParams?: Record<string, unknown>
}) {
	return await invokePackageExport({
		env: input.env,
		baseUrl: input.baseUrl ?? getAppBaseUrl({ env: input.env }),
		token: {
			tokenId: `internal:webhook:${input.endpoint.id}`,
			userId: input.endpoint.userId,
			packageId: input.endpoint.packageId,
			exportNames: [input.exportName],
		},
		request: {
			packageIdOrKodyId: input.endpoint.packageId,
			exportName: input.exportName,
			params: input.params,
			idempotencyKey: input.idempotencyKey,
			...(input.idempotencyParamsHash === 'ignore'
				? { idempotencyParamsHash: 'ignore' as const }
				: {}),
			...(input.idempotencyHashParams
				? { idempotencyHashParams: input.idempotencyHashParams }
				: {}),
			source: 'webhook',
			topic: `webhook:${input.packageKodyId}:${input.endpoint.webhookName}`,
		},
	})
}
