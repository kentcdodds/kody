import { canonicalJsonStringify } from '@kody-internal/shared/canonical-json.ts'
import { listJsonSchemaSubsetValueErrors } from '@kody-internal/shared/json-schema-subset.ts'
import { toHex } from '@kody-internal/shared/hex.ts'
import { runWithDynamicWorkerEvaluationBudget } from '#mcp/executor.ts'
import { type createMcpCallerContext } from '#mcp/context.ts'
import { listAttachedRemoteConnectorRefsCached } from '#worker/mcp-auth-user-context.ts'
import {
	type PackageEventDispatchInput,
	type PackageEventTools,
} from '#mcp/run-kody-registry.ts'
import { type RunRecordContext } from '#worker/run-records/types.ts'
import { listSavedPackagesByUserId } from '#worker/package-registry/repo.ts'
import { type SavedPackageRecord } from '#worker/package-registry/types.ts'
import { loadPackageManifestBySourceId } from '#worker/package-registry/source.ts'
import {
	listPackageEmittedEvents,
	listPackageSubscriptions,
} from '#worker/package-registry/manifest.ts'
import { type PackageEventsDispatchQueueMessage } from '#worker/package-events/dispatch-queue-producer.ts'
import {
	buildPackageSubscriptionArtifactName,
	normalizePackageSubscriptionTopic,
} from '#worker/package-runtime/subscription-artifacts.ts'
import {
	isTrustedSyntheticSubscriptionDispatch,
	stripUntrustedSubscriptionEnvelopeFields,
	type TrustedSyntheticSubscriptionDispatch,
} from './subscription-envelope.ts'
import { readPreExecutionPackageInvocationInfrastructureCode } from './infrastructure-codes.ts'
import {
	internalEmailSubscriptionTokenId,
	internalPackageEventSubscriptionTokenId,
	maxPackageRuntimeInvokeDepth,
	normalizeNullableString,
	syntheticPackageSubscriptionSource,
	type LoadedPackageEventSubscription,
	type PackageInvocationResponse,
	type PackageRuntimeContext,
	type PackageRuntimeToolFactories,
} from './common.ts'
import { invokeSavedPackageModule } from './idempotent-module-invocation.ts'
import { buildJsonErrorResponse } from './responses.ts'

/**
 * Package event payloads ride inside a Queue message (128 KiB limit), so
 * the payload itself is capped well below that to leave envelope headroom.
 */
export const maxPackageEventPayloadBytes = 64 * 1024

function parsePackageEventDispatchInput(rawInput: PackageEventDispatchInput) {
	const input =
		rawInput && typeof rawInput === 'object' && !Array.isArray(rawInput)
			? rawInput
			: {}
	const topic =
		typeof input.topic === 'string'
			? normalizePackageSubscriptionTopic(input.topic)
			: ''
	if (!topic) {
		throw new Error('events.dispatch requires a non-empty topic.')
	}
	const idempotencyKey =
		typeof input.idempotencyKey === 'string' ? input.idempotencyKey.trim() : ''
	if (!idempotencyKey) {
		throw new Error('events.dispatch requires a non-empty idempotencyKey.')
	}
	const rawPayload = input.payload ?? {}
	if (
		!rawPayload ||
		typeof rawPayload !== 'object' ||
		Array.isArray(rawPayload)
	) {
		throw new Error(
			'events.dispatch payload must be a JSON object when provided.',
		)
	}
	const payload = stripUntrustedSubscriptionEnvelopeFields(
		rawPayload as Record<string, unknown>,
	)
	return {
		topic,
		idempotencyKey,
		payload: payload as Record<string, unknown>,
	}
}

async function buildPackageEventSubscriptionIdempotencyKey(input: {
	sourcePackageId: string
	subscriberPackageId: string
	topic: string
	idempotencyKey: string
}) {
	const digest = await crypto.subtle.digest(
		'SHA-256',
		new TextEncoder().encode(canonicalJsonStringify(input)),
	)
	return [
		'pkgevent',
		input.sourcePackageId,
		input.subscriberPackageId,
		input.topic,
		toHex(new Uint8Array(digest)).slice(0, 24),
	].join(':')
}

function readInvocationError(response: PackageInvocationResponse) {
	const errorRecord =
		(response.body['error'] as Record<string, unknown> | undefined) ?? {}
	return {
		code: String(errorRecord['code'] ?? 'package_subscription_failed'),
		message: String(
			errorRecord['message'] ??
				`Package subscription failed with HTTP ${response.status}.`,
		),
	}
}

/**
 * Filter semantics for package-emitted topics: every declared filter key
 * must be present in the event payload with a canonically-equal JSON value.
 * Subscriptions without filters receive every event on the topic.
 */
export function packageEventFiltersMatchPayload(input: {
	filters: Record<string, unknown> | null
	payload: Record<string, unknown>
}) {
	if (!input.filters) return true
	return Object.entries(input.filters).every(
		([key, expected]) =>
			key in input.payload &&
			canonicalJsonStringify(input.payload[key]) ===
				canonicalJsonStringify(expected),
	)
}

async function loadMatchingPackageEventSubscriptions(input: {
	env: Env
	baseUrl: string
	userId: string
	topic: string
	payload: Record<string, unknown>
}) {
	const savedPackages = await listSavedPackagesByUserId(input.env.APP_DB, {
		userId: input.userId,
	})
	const settled = await Promise.all(
		savedPackages.map(async (savedPackage) => {
			const loaded = await loadPackageManifestBySourceId({
				env: input.env,
				baseUrl: input.baseUrl,
				userId: input.userId,
				sourceId: savedPackage.sourceId,
			}).catch((error) => {
				throw new Error(
					`Failed to load package manifest for package event dispatch: ${savedPackage.kodyId} (${savedPackage.id}).`,
					{ cause: error },
				)
			})
			const subscription = listPackageSubscriptions(loaded.manifest).find(
				(candidate) =>
					candidate.topic === input.topic &&
					packageEventFiltersMatchPayload({
						filters: candidate.filters,
						payload: input.payload,
					}),
			)
			if (!subscription) return null
			return {
				savedPackage,
				subscription,
			}
		}),
	)
	return settled.filter(
		(entry): entry is LoadedPackageEventSubscription => entry !== null,
	)
}

export type PackageEventDeliveryResult = {
	topic: string
	source: { type: 'package'; packageId: string; kodyId: string }
	idempotencyKey: string
	subscribers: Array<{
		packageId: string
		kodyId: string
		handler: string
		status: 'completed' | 'replayed' | 'failed'
		error?: { code: string; message: string }
	}>
	delivered: number
	failed: number
}

/**
 * Queue-consumer side of package event dispatch: resolve the emitting
 * user's matching subscriptions and invoke each handler with exactly-once
 * idempotency. Throws when subscriber discovery fails or an invocation
 * fails before user code ran (both retryable via Queue redelivery); user
 * handler failures are terminal and reported in the returned summary (the
 * idempotency ledger would replay a stored failure on retry anyway).
 */
export async function deliverPackageEventWithToolFactories(input: {
	env: Env
	baseUrl: string
	message: PackageEventsDispatchQueueMessage
	toolFactories: PackageRuntimeToolFactories
	waitUntil?: (promise: Promise<unknown>) => void
}): Promise<PackageEventDeliveryResult> {
	const message = input.message
	const subscriptions = await loadMatchingPackageEventSubscriptions({
		env: input.env,
		baseUrl: input.baseUrl,
		userId: message.userId,
		topic: message.topic,
		payload: message.payload,
	})
	const envelope = stripUntrustedSubscriptionEnvelopeFields({
		event: message.topic,
		source: {
			type: 'package',
			package_id: message.source.packageId,
			kody_id: message.source.kodyId,
		},
		idempotency_key: message.idempotencyKey,
		payload: message.payload,
	}) as Record<string, unknown>
	const subscribers: PackageEventDeliveryResult['subscribers'] = []
	const retryableInfrastructureErrors: Array<Error> = []
	await runWithDynamicWorkerEvaluationBudget(async () => {
		for (const { savedPackage, subscription } of subscriptions) {
			const response = await invokePackageSubscriptionWithToolFactories({
				env: input.env,
				baseUrl: input.baseUrl,
				savedPackage,
				topic: message.topic,
				params: envelope,
				idempotencyKey: await buildPackageEventSubscriptionIdempotencyKey({
					sourcePackageId: message.source.packageId,
					subscriberPackageId: savedPackage.id,
					topic: message.topic,
					idempotencyKey: message.idempotencyKey,
				}),
				source: `package:${message.source.kodyId}`,
				actorTokenId: `${internalPackageEventSubscriptionTokenId}:${message.source.packageId}`,
				runtimeInvokeDepth: message.invokeDepth,
				toolFactories: input.toolFactories,
				waitUntil: input.waitUntil,
			})
			const retryableCode =
				readPreExecutionPackageInvocationInfrastructureCode(response)
			if (retryableCode) {
				retryableInfrastructureErrors.push(
					new Error(
						`Retryable package invocation infrastructure response: ${retryableCode}.`,
					),
				)
			}
			const replayed =
				(response.body['idempotency'] as { replayed?: unknown } | undefined)
					?.replayed === true
			const status =
				response.status >= 200 && response.status < 400
					? replayed
						? 'replayed'
						: 'completed'
					: 'failed'
			subscribers.push({
				packageId: savedPackage.id,
				kodyId: savedPackage.kodyId,
				handler: subscription.handler,
				status,
				...(status === 'failed'
					? { error: readInvocationError(response) }
					: {}),
			})
		}
	})
	if (retryableInfrastructureErrors.length > 0) {
		throw new Error('Package event dispatch was incomplete.', {
			cause: retryableInfrastructureErrors[0],
		})
	}
	const failed = subscribers.filter(
		(subscriber) => subscriber.status === 'failed',
	).length
	return {
		topic: message.topic,
		source: {
			type: 'package',
			packageId: message.source.packageId,
			kodyId: message.source.kodyId,
		},
		idempotencyKey: message.idempotencyKey,
		subscribers,
		delivered: subscribers.length - failed,
		failed,
	}
}

export function createPackageEventToolsWithToolFactories(input: {
	env: Env
	baseUrl: string
	callerContext: ReturnType<typeof createMcpCallerContext>
	packageContext: PackageRuntimeContext | null
	parentRunRecord?: RunRecordContext | null
	packageInvokeDepth?: number
	toolFactories: PackageRuntimeToolFactories
	waitUntil?: (promise: Promise<unknown>) => void
}): PackageEventTools {
	return {
		dispatch: async (rawInput) => {
			const user = input.callerContext.user
			if (!user?.userId) {
				throw new Error('events.dispatch requires an authenticated user.')
			}
			if (!input.packageContext) {
				throw new Error('events.dispatch requires a package runtime context.')
			}
			const packageContext = input.packageContext
			const packageInvokeDepth = input.packageInvokeDepth ?? 0
			if (packageInvokeDepth >= maxPackageRuntimeInvokeDepth) {
				throw new Error(
					`events.dispatch exceeded the maximum nested invocation depth (${maxPackageRuntimeInvokeDepth}).`,
				)
			}
			const request = parsePackageEventDispatchInput(rawInput)
			const sourceId = packageContext.sourceId?.trim()
			if (!sourceId) {
				throw new Error('events.dispatch requires a published package source.')
			}
			const sourceManifest = await loadPackageManifestBySourceId({
				env: input.env,
				baseUrl: input.baseUrl,
				userId: user.userId,
				sourceId,
			})
			const declaredEvent = listPackageEmittedEvents(
				sourceManifest.manifest,
			).find((event) => event.topic === request.topic)
			if (!declaredEvent) {
				throw new Error(
					`Package "${packageContext.kodyId}" does not declare emitted event "${request.topic}" in package.json#kody.emits.`,
				)
			}
			if (declaredEvent.payloadSchema) {
				const errors = listJsonSchemaSubsetValueErrors(
					declaredEvent.payloadSchema,
					request.payload,
				)
				if (errors.length > 0) {
					throw new Error(
						`events.dispatch payload does not match the declared payloadSchema for "${request.topic}":\n${errors.join('\n')}`,
					)
				}
			}
			const payloadBytes = new TextEncoder().encode(
				canonicalJsonStringify(request.payload),
			).byteLength
			if (payloadBytes > maxPackageEventPayloadBytes) {
				throw new Error(
					`events.dispatch payload is ${payloadBytes} bytes; the maximum is ${maxPackageEventPayloadBytes} bytes. Store large data in packageStorage() and emit a reference instead.`,
				)
			}
			const message: PackageEventsDispatchQueueMessage = {
				userId: user.userId,
				topic: request.topic,
				idempotencyKey: request.idempotencyKey,
				payload: request.payload,
				source: {
					packageId: packageContext.packageId,
					kodyId: packageContext.kodyId,
				},
				invokeDepth: packageInvokeDepth + 1,
			}
			const queue = (input.env as Partial<Env>).PACKAGE_EVENTS_DISPATCH_QUEUE
			let enqueued = false
			if (queue) {
				try {
					await queue.send(message)
					enqueued = true
				} catch (error) {
					console.error('package-events-dispatch-enqueue-failed', {
						topic: message.topic,
						sourcePackageId: message.source.packageId,
						error,
					})
				}
			}
			if (!enqueued) {
				// No Queue binding (local dev / preview) or enqueue failure:
				// deliver inline with the same consumer code path so events
				// still reach subscribers. Delivery failures are logged, never
				// surfaced to the emitter — matching queued semantics.
				const inlineDelivery = deliverPackageEventWithToolFactories({
					env: input.env,
					baseUrl: input.baseUrl,
					message,
					toolFactories: input.toolFactories,
					waitUntil: input.waitUntil,
				}).catch((error) => {
					console.error('package-events-inline-delivery-failed', {
						topic: message.topic,
						sourcePackageId: message.source.packageId,
						error,
					})
				})
				if (input.waitUntil) {
					input.waitUntil(inlineDelivery)
				} else {
					await inlineDelivery
				}
			}
			return {
				topic: request.topic,
				source: {
					type: 'package',
					packageId: packageContext.packageId,
					kodyId: packageContext.kodyId,
				},
				idempotencyKey: request.idempotencyKey,
				status: enqueued ? 'enqueued' : 'delivered_inline',
			}
		},
	}
}

export async function invokePackageSubscriptionWithToolFactories(input: {
	env: Env
	baseUrl: string
	savedPackage: SavedPackageRecord
	topic: string
	params?: Record<string, unknown>
	idempotencyKey: string
	source?: string | null
	trustedSyntheticDispatch?: TrustedSyntheticSubscriptionDispatch
	actorTokenId?: string
	runtimeInvokeDepth?: number
	toolFactories: PackageRuntimeToolFactories
	waitUntil?: (promise: Promise<unknown>) => void
}) {
	const topic = normalizePackageSubscriptionTopic(input.topic)
	const idempotencyKey = input.idempotencyKey.trim()
	if (!idempotencyKey) {
		return buildJsonErrorResponse({
			status: 400,
			code: 'missing_idempotency_key',
			message:
				'Package subscription invocations require a non-empty idempotencyKey.',
		})
	}
	const synthetic = isTrustedSyntheticSubscriptionDispatch(
		input.trustedSyntheticDispatch,
	)
	const requestedSource = normalizeNullableString(input.source)
	const source = synthetic
		? syntheticPackageSubscriptionSource
		: requestedSource === syntheticPackageSubscriptionSource
			? 'email'
			: (requestedSource ?? 'email')
	const params = synthetic
		? input.params
		: stripUntrustedSubscriptionEnvelopeFields(input.params)
	const remoteConnectors = [
		...(await listAttachedRemoteConnectorRefsCached({
			env: input.env,
			userId: input.savedPackage.userId,
		})),
	]
	return await invokeSavedPackageModule({
		env: input.env,
		baseUrl: input.baseUrl,
		actor: {
			tokenId: input.actorTokenId ?? internalEmailSubscriptionTokenId,
			userId: input.savedPackage.userId,
			remoteConnectors,
		},
		savedPackage: input.savedPackage,
		invocationName: buildPackageSubscriptionArtifactName(topic),
		moduleSelector: {
			kind: 'subscription',
			topic,
		},
		params,
		idempotencyKey,
		source,
		topic,
		notFoundCode: 'subscription_not_found',
		runtimeInvokeDepth: input.runtimeInvokeDepth ?? 0,
		toolFactories: input.toolFactories,
		waitUntil: input.waitUntil,
	})
}
