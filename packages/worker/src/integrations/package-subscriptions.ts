import { getAppBaseUrl } from '#worker/app-base-url.ts'
import { runWithDynamicWorkerEvaluationBudget } from '#mcp/executor.ts'
import { readPreExecutionPackageInvocationInfrastructureCode } from '#worker/package-invocations/admin-package-subscriptions.ts'
import { invokePackageSubscription } from '#worker/package-invocations/service.ts'
import { listPackageSubscriptions } from '#worker/package-registry/manifest.ts'
import { listSavedPackagesByUserId } from '#worker/package-registry/repo.ts'
import { loadPackageManifestBySourceId } from '#worker/package-registry/source.ts'
import { type SavedPackageRecord } from '#worker/package-registry/types.ts'
import {
	buildIntegrationAccountUrl,
	buildIntegrationReconnectUrl,
} from './account-identity.ts'
import { type IntegrationAuthFailedReason } from './token-refresh.ts'

export const integrationAuthFailedTopic = 'integration.auth.failed'
export const integrationAuthSucceededTopic = 'integration.auth.succeeded'

export const integrationAuthSucceededSources = [
	'refresh',
	'oauth_connect',
] as const

export type IntegrationAuthSucceededSource =
	(typeof integrationAuthSucceededSources)[number]

export type IntegrationAuthConnection = {
	name: string
	lane: 'user' | 'platform'
	account_label: string | null
	description: string | null
	provider: string | null
	platform_app_slug: string | null
	scopes: Array<string>
	connected_at: string | null
	token_refreshed_at: string | null
}

export type IntegrationAuthFailedSubscriptionEnvelope = {
	event: typeof integrationAuthFailedTopic
	event_id: string
	integration: IntegrationAuthConnection
	reason: IntegrationAuthFailedReason
	provider: {
		error: string | null
		error_description: string | null
		http_status: number | null
	}
	reconnect_url: string
	account_url: string
	occurred_at: string
}

export type IntegrationAuthSucceededSubscriptionEnvelope = {
	event: typeof integrationAuthSucceededTopic
	event_id: string
	integration: IntegrationAuthConnection
	source: IntegrationAuthSucceededSource
	account_url: string
	occurred_at: string
}

type IntegrationAuthTopic =
	| typeof integrationAuthFailedTopic
	| typeof integrationAuthSucceededTopic

type LoadedAuthSubscription = {
	savedPackage: SavedPackageRecord
	subscription: ReturnType<typeof listPackageSubscriptions>[number]
}

export function buildIntegrationAuthFailedReconnectUrl(input: {
	baseUrl: string
	integrationName: string
	accountLabel?: string | null
}) {
	return buildIntegrationReconnectUrl({
		baseUrl: input.baseUrl,
		integrationName: input.integrationName,
		accountLabel: input.accountLabel,
	})
}

export function buildIntegrationAuthAccountUrl(input: {
	baseUrl: string
	integrationName: string
}) {
	return buildIntegrationAccountUrl(input)
}

function buildSubscriptionIdempotencyKey(input: {
	topic: IntegrationAuthTopic
	eventId: string
	packageId: string
}) {
	const prefix =
		input.topic === integrationAuthFailedTopic
			? 'integration-auth-failed'
			: 'integration-auth-succeeded'
	return `${prefix}:${input.eventId}:${input.packageId}`
}

function buildFailedEventPayload(input: {
	baseUrl: string
	eventId: string
	occurredAt: string
	integration: IntegrationAuthConnection
	reason: IntegrationAuthFailedReason
	provider: IntegrationAuthFailedSubscriptionEnvelope['provider']
}): IntegrationAuthFailedSubscriptionEnvelope {
	return {
		event: integrationAuthFailedTopic,
		event_id: input.eventId,
		integration: input.integration,
		reason: input.reason,
		provider: input.provider,
		reconnect_url: buildIntegrationAuthFailedReconnectUrl({
			baseUrl: input.baseUrl,
			integrationName: input.integration.name,
			accountLabel: input.integration.account_label,
		}),
		account_url: buildIntegrationAccountUrl({
			baseUrl: input.baseUrl,
			integrationName: input.integration.name,
		}),
		occurred_at: input.occurredAt,
	}
}

function buildSucceededEventPayload(input: {
	baseUrl: string
	eventId: string
	occurredAt: string
	integration: IntegrationAuthConnection
	source: IntegrationAuthSucceededSource
}): IntegrationAuthSucceededSubscriptionEnvelope {
	return {
		event: integrationAuthSucceededTopic,
		event_id: input.eventId,
		integration: input.integration,
		source: input.source,
		account_url: buildIntegrationAuthAccountUrl({
			baseUrl: input.baseUrl,
			integrationName: input.integration.name,
		}),
		occurred_at: input.occurredAt,
	}
}

async function loadMatchingAuthSubscriptions(input: {
	env: Pick<Env, 'APP_DB' | 'BUNDLE_ARTIFACTS_KV'>
	baseUrl: string
	userId: string
	topic: IntegrationAuthTopic
}) {
	let savedPackages: Array<SavedPackageRecord>
	try {
		savedPackages = await listSavedPackagesByUserId(input.env.APP_DB, {
			userId: input.userId,
		})
	} catch (error) {
		const missingTable =
			error instanceof Error &&
			error.message.includes('no such table: saved_packages')
		return {
			subscriptions: [] as Array<LoadedAuthSubscription>,
			discoveryErrors: missingTable ? [] : [error],
		}
	}
	const settled = await Promise.allSettled(
		savedPackages.map(async (savedPackage) => {
			const loaded = await loadPackageManifestBySourceId({
				env: input.env as Env,
				baseUrl: input.baseUrl,
				userId: input.userId,
				sourceId: savedPackage.sourceId,
			})
			const subscription = listPackageSubscriptions(loaded.manifest).find(
				(candidate) => candidate.topic === input.topic,
			)
			if (!subscription) return null
			return {
				savedPackage,
				subscription,
			} satisfies LoadedAuthSubscription
		}),
	)
	const subscriptions: Array<LoadedAuthSubscription> = []
	const discoveryErrors: Array<unknown> = []
	for (const [index, result] of settled.entries()) {
		if (result.status === 'fulfilled') {
			if (result.value) subscriptions.push(result.value)
			continue
		}
		const savedPackage = savedPackages[index]
		console.warn(
			`Failed to load package manifest for ${input.topic} subscription`,
			{
				sourceId: savedPackage?.sourceId,
				packageId: savedPackage?.id,
				error: result.reason,
			},
		)
		discoveryErrors.push(result.reason)
	}
	return { subscriptions, discoveryErrors }
}

async function dispatchIntegrationAuthSubscriptionEvents(input: {
	env: Pick<Env, 'APP_DB' | 'BUNDLE_ARTIFACTS_KV' | 'APP_BASE_URL'>
	userId: string
	eventId: string
	topic: IntegrationAuthTopic
	eventPayload: Record<string, unknown>
	integrationName: string
	waitUntil?: (promise: Promise<unknown>) => void
}) {
	const baseUrl = getAppBaseUrl({ env: input.env })
	const { subscriptions, discoveryErrors } =
		await loadMatchingAuthSubscriptions({
			env: input.env,
			baseUrl,
			userId: input.userId,
			topic: input.topic,
		})
	const settled = await runWithDynamicWorkerEvaluationBudget(
		async () =>
			await Promise.allSettled(
				subscriptions.map(async ({ savedPackage }) => {
					const response = await invokePackageSubscription({
						env: input.env as Env,
						baseUrl,
						savedPackage,
						topic: input.topic,
						params: input.eventPayload,
						idempotencyKey: buildSubscriptionIdempotencyKey({
							topic: input.topic,
							eventId: input.eventId,
							packageId: savedPackage.id,
						}),
						source: 'integrations',
						waitUntil: input.waitUntil,
					})
					const retryableCode =
						readPreExecutionPackageInvocationInfrastructureCode(response)
					if (retryableCode) {
						throw new Error(
							`Retryable package invocation infrastructure response: ${retryableCode}.`,
						)
					}
					return response
				}),
			),
	)
	for (const result of settled) {
		if (result.status === 'rejected') {
			console.warn(`${input.topic} package subscription invoke failed`, {
				eventId: input.eventId,
				integrationName: input.integrationName,
				error: result.reason,
			})
		}
	}
	if (discoveryErrors.length > 0) {
		console.warn(`${input.topic} package subscription discovery incomplete`, {
			eventId: input.eventId,
			integrationName: input.integrationName,
			errorCount: discoveryErrors.length,
			error: discoveryErrors[0],
		})
	}
	return settled.map((result) =>
		result.status === 'fulfilled' ? result.value : null,
	)
}

/**
 * Fan a reconnectable OAuth refresh failure out to the owning user's packages
 * that declare `integration.auth.failed`. Best-effort: discovery and invocation
 * infrastructure failures are logged, never thrown — the refresh caller must
 * still receive the original error. Sibling handler terminal failures are
 * isolated via `Promise.allSettled`.
 *
 * Every classified caller-error emits. The platform does not coalesce repeats;
 * notifier packages decide how often to ping, typically by pairing this topic
 * with `integration.auth.succeeded` and storing last-known health.
 */
export async function dispatchIntegrationAuthFailedSubscriptionEvents(input: {
	env: Pick<Env, 'APP_DB' | 'BUNDLE_ARTIFACTS_KV' | 'APP_BASE_URL'>
	userId: string
	eventId: string
	occurredAt: string
	integration: IntegrationAuthConnection
	reason: IntegrationAuthFailedReason
	provider: IntegrationAuthFailedSubscriptionEnvelope['provider']
	waitUntil?: (promise: Promise<unknown>) => void
}) {
	const baseUrl = getAppBaseUrl({ env: input.env })
	return dispatchIntegrationAuthSubscriptionEvents({
		env: input.env,
		userId: input.userId,
		eventId: input.eventId,
		topic: integrationAuthFailedTopic,
		eventPayload: buildFailedEventPayload({
			baseUrl,
			eventId: input.eventId,
			occurredAt: input.occurredAt,
			integration: input.integration,
			reason: input.reason,
			provider: input.provider,
		}) as Record<string, unknown>,
		integrationName: input.integration.name,
		waitUntil: input.waitUntil,
	})
}

/**
 * Fan a successful OAuth grant (host-side refresh or `/connect/oauth` persist)
 * out to the owning user's packages that declare `integration.auth.succeeded`.
 * Best-effort: discovery and invocation infrastructure failures are logged,
 * never thrown. Every successful refresh or connect persist emits; notifier
 * packages edge-detect working ↔ failed in their own storage.
 */
export async function dispatchIntegrationAuthSucceededSubscriptionEvents(input: {
	env: Pick<Env, 'APP_DB' | 'BUNDLE_ARTIFACTS_KV' | 'APP_BASE_URL'>
	userId: string
	eventId: string
	occurredAt: string
	integration: IntegrationAuthConnection
	source: IntegrationAuthSucceededSource
	waitUntil?: (promise: Promise<unknown>) => void
}) {
	const baseUrl = getAppBaseUrl({ env: input.env })
	return dispatchIntegrationAuthSubscriptionEvents({
		env: input.env,
		userId: input.userId,
		eventId: input.eventId,
		topic: integrationAuthSucceededTopic,
		eventPayload: buildSucceededEventPayload({
			baseUrl,
			eventId: input.eventId,
			occurredAt: input.occurredAt,
			integration: input.integration,
			source: input.source,
		}) as Record<string, unknown>,
		integrationName: input.integration.name,
		waitUntil: input.waitUntil,
	})
}
