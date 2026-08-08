import { getAppBaseUrl } from '#worker/app-base-url.ts'
import { invokePackageExport } from '#worker/package-invocations/service.ts'
import { listAttachedRemoteConnectorRefs } from '#worker/remote-connector/settings-service.ts'
import { recordRunRecord } from '#worker/run-records/service.ts'
import {
	type WebhookDeliveryOutcome,
	type WebhookEndpointRecord,
	type WebhookExportParams,
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
	waitUntil?: (promise: Promise<unknown>) => void
	requirePersistence?: boolean
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
			},
		},
		status,
		error: input.error ?? undefined,
		result: input.result,
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

export async function dispatchWebhookInvocation(input: {
	env: Env
	baseUrl?: string
	endpoint: Pick<
		WebhookEndpointRecord,
		'id' | 'userId' | 'packageId' | 'webhookName'
	>
	packageKodyId: string
	exportName: string
	params: WebhookExportParams
	idempotencyKey: string
}) {
	const remoteConnectors = await listAttachedRemoteConnectorRefs({
		env: input.env,
		userId: input.endpoint.userId,
	})
	return await invokePackageExport({
		env: input.env,
		baseUrl: input.baseUrl ?? getAppBaseUrl({ env: input.env }),
		token: {
			tokenId: `internal:webhook:${input.endpoint.id}`,
			userId: input.endpoint.userId,
			packageIds: [input.endpoint.packageId],
			packageKodyIds: [input.packageKodyId],
			exportNames: [input.exportName],
			sources: ['webhook'],
			remoteConnectors,
		},
		request: {
			packageIdOrKodyId: input.endpoint.packageId,
			exportName: input.exportName,
			params: input.params,
			idempotencyKey: input.idempotencyKey,
			source: 'webhook',
			topic: `webhook:${input.packageKodyId}:${input.endpoint.webhookName}`,
		},
	})
}
