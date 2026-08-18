import { getAppBaseUrl } from '#worker/app-base-url.ts'
import { runWithDynamicWorkerEvaluationBudget } from '#mcp/executor.ts'
import { readPreExecutionPackageInvocationInfrastructureCode } from '#worker/package-invocations/admin-package-subscriptions.ts'
import { invokePackageSubscription } from '#worker/package-invocations/service.ts'
import { listPackageSubscriptions } from '#worker/package-registry/manifest.ts'
import { listSavedPackagesByUserId } from '#worker/package-registry/repo.ts'
import { loadPackageManifestBySourceId } from '#worker/package-registry/source.ts'
import { type SavedPackageRecord } from '#worker/package-registry/types.ts'
import { type IntegrationAuthFailedReason } from './token-refresh.ts'

export const integrationAuthFailedTopic = 'integration.auth.failed'

export type IntegrationAuthFailedSubscriptionEnvelope = {
	event: typeof integrationAuthFailedTopic
	event_id: string
	integration: {
		name: string
		lane: 'user' | 'platform'
		account_label: string | null
		provider: string | null
		platform_app_slug: string | null
	}
	reason: IntegrationAuthFailedReason
	provider: {
		error: string | null
		error_description: string | null
		http_status: number | null
	}
	reconnect_url: string
	occurred_at: string
}

type LoadedAuthFailedSubscription = {
	savedPackage: SavedPackageRecord
	subscription: ReturnType<typeof listPackageSubscriptions>[number]
}

export function buildIntegrationAuthFailedReconnectUrl(input: {
	baseUrl: string
	integrationName: string
}) {
	return `${input.baseUrl}/connect/oauth?provider=${encodeURIComponent(input.integrationName)}`
}

function buildSubscriptionIdempotencyKey(input: {
	eventId: string
	packageId: string
}) {
	return `integration-auth-failed:${input.eventId}:${input.packageId}`
}

function buildEventPayload(input: {
	baseUrl: string
	eventId: string
	occurredAt: string
	integration: IntegrationAuthFailedSubscriptionEnvelope['integration']
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
		}),
		occurred_at: input.occurredAt,
	}
}

async function loadMatchingAuthFailedSubscriptions(input: {
	env: Pick<Env, 'APP_DB' | 'BUNDLE_ARTIFACTS_KV'>
	baseUrl: string
	userId: string
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
			subscriptions: [] as Array<LoadedAuthFailedSubscription>,
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
				(candidate) => candidate.topic === integrationAuthFailedTopic,
			)
			if (!subscription) return null
			return {
				savedPackage,
				subscription,
			} satisfies LoadedAuthFailedSubscription
		}),
	)
	const subscriptions: Array<LoadedAuthFailedSubscription> = []
	const discoveryErrors: Array<unknown> = []
	for (const [index, result] of settled.entries()) {
		if (result.status === 'fulfilled') {
			if (result.value) subscriptions.push(result.value)
			continue
		}
		const savedPackage = savedPackages[index]
		console.warn(
			'Failed to load package manifest for integration.auth.failed subscription',
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

/**
 * Fan a reconnectable OAuth refresh failure out to the owning user's packages
 * that declare `integration.auth.failed`. Best-effort: discovery and invocation
 * infrastructure failures are logged, never thrown — the refresh caller must
 * still receive the original error. Sibling handler terminal failures are
 * isolated via `Promise.allSettled`.
 *
 * Every classified caller-error emits. The platform does not coalesce repeats;
 * notifier packages decide how often to ping.
 */
export async function dispatchIntegrationAuthFailedSubscriptionEvents(input: {
	env: Pick<Env, 'APP_DB' | 'BUNDLE_ARTIFACTS_KV' | 'APP_BASE_URL'>
	userId: string
	eventId: string
	occurredAt: string
	integration: IntegrationAuthFailedSubscriptionEnvelope['integration']
	reason: IntegrationAuthFailedReason
	provider: IntegrationAuthFailedSubscriptionEnvelope['provider']
	waitUntil?: (promise: Promise<unknown>) => void
}) {
	const baseUrl = getAppBaseUrl({ env: input.env })
	const { subscriptions, discoveryErrors } =
		await loadMatchingAuthFailedSubscriptions({
			env: input.env,
			baseUrl,
			userId: input.userId,
		})
	const eventPayload = buildEventPayload({
		baseUrl,
		eventId: input.eventId,
		occurredAt: input.occurredAt,
		integration: input.integration,
		reason: input.reason,
		provider: input.provider,
	})
	const settled = await runWithDynamicWorkerEvaluationBudget(
		async () =>
			await Promise.allSettled(
				subscriptions.map(async ({ savedPackage }) => {
					const response = await invokePackageSubscription({
						env: input.env as Env,
						baseUrl,
						savedPackage,
						topic: integrationAuthFailedTopic,
						params: eventPayload as Record<string, unknown>,
						idempotencyKey: buildSubscriptionIdempotencyKey({
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
			console.warn(
				'integration.auth.failed package subscription invoke failed',
				{
					eventId: input.eventId,
					integrationName: input.integration.name,
					error: result.reason,
				},
			)
		}
	}
	if (discoveryErrors.length > 0) {
		console.warn(
			'integration.auth.failed package subscription discovery incomplete',
			{
				eventId: input.eventId,
				integrationName: input.integration.name,
				errorCount: discoveryErrors.length,
				error: discoveryErrors[0],
			},
		)
	}
	return settled.map((result) =>
		result.status === 'fulfilled' ? result.value : null,
	)
}
