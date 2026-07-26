import { canonicalJsonStringify } from '@kody-internal/shared/canonical-json.ts'
import { toHex } from '@kody-internal/shared/hex.ts'
import { type createMcpCallerContext } from '#mcp/context.ts'
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
import {
	buildPackageSubscriptionArtifactName,
	normalizePackageSubscriptionTopic,
} from '#worker/package-runtime/subscription-artifacts.ts'
import {
	internalEmailSubscriptionTokenId,
	internalPackageEventSubscriptionTokenId,
	maxPackageRuntimeInvokeDepth,
	normalizeNullableString,
	type LoadedPackageEventSubscription,
	type PackageInvocationResponse,
	type PackageRuntimeContext,
	type PackageRuntimeToolFactories,
} from './common.ts'
import { invokeSavedPackageModule } from './idempotent-module-invocation.ts'
import { buildJsonErrorResponse } from './responses.ts'

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
	const payload = input.payload ?? {}
	if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
		throw new Error(
			'events.dispatch payload must be a JSON object when provided.',
		)
	}
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

async function loadMatchingPackageEventSubscriptions(input: {
	env: Env
	baseUrl: string
	userId: string
	topic: string
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
				(candidate) => candidate.topic === input.topic,
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
			const subscriptions = await loadMatchingPackageEventSubscriptions({
				env: input.env,
				baseUrl: input.baseUrl,
				userId: user.userId,
				topic: request.topic,
			})
			const envelope = {
				event: request.topic,
				source: {
					type: 'package',
					package_id: packageContext.packageId,
					kody_id: packageContext.kodyId,
				},
				idempotency_key: request.idempotencyKey,
				payload: request.payload,
			}
			const subscribers = []
			for (const { savedPackage, subscription } of subscriptions) {
				const response = await invokePackageSubscriptionWithToolFactories({
					env: input.env,
					baseUrl: input.baseUrl,
					savedPackage,
					topic: request.topic,
					params: envelope,
					idempotencyKey: await buildPackageEventSubscriptionIdempotencyKey({
						sourcePackageId: packageContext.packageId,
						subscriberPackageId: savedPackage.id,
						topic: request.topic,
						idempotencyKey: request.idempotencyKey,
					}),
					source: `package:${packageContext.kodyId}`,
					actorTokenId: `${internalPackageEventSubscriptionTokenId}:${packageContext.packageId}`,
					actorDisplayName: `package:${packageContext.kodyId}`,
					runtimeInvokeDepth: packageInvokeDepth + 1,
					toolFactories: input.toolFactories,
					waitUntil: input.waitUntil,
				})
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
			const failed = subscribers.filter(
				(subscriber) => subscriber.status === 'failed',
			).length
			return {
				topic: request.topic,
				source: {
					type: 'package',
					packageId: packageContext.packageId,
					kodyId: packageContext.kodyId,
				},
				idempotencyKey: request.idempotencyKey,
				subscribers,
				delivered: subscribers.length - failed,
				failed,
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
	actorTokenId?: string
	actorDisplayName?: string
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
	return await invokeSavedPackageModule({
		env: input.env,
		baseUrl: input.baseUrl,
		actor: {
			tokenId: input.actorTokenId ?? internalEmailSubscriptionTokenId,
			userId: input.savedPackage.userId,
			email: '',
			displayName:
				input.actorDisplayName ?? `package:${input.savedPackage.kodyId}`,
		},
		savedPackage: input.savedPackage,
		invocationName: buildPackageSubscriptionArtifactName(topic),
		moduleSelector: {
			kind: 'subscription',
			topic,
		},
		params: input.params,
		idempotencyKey,
		source: normalizeNullableString(input.source) ?? 'email',
		topic,
		notFoundCode: 'subscription_not_found',
		runtimeInvokeDepth: input.runtimeInvokeDepth ?? 0,
		toolFactories: input.toolFactories,
		waitUntil: input.waitUntil,
	})
}
