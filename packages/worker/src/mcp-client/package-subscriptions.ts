import { getAppBaseUrl } from '#worker/app-base-url.ts'
import { runWithDynamicWorkerEvaluationBudget } from '#mcp/executor.ts'
import { readPreExecutionPackageInvocationInfrastructureCode } from '#worker/package-invocations/admin-package-subscriptions.ts'
import { invokePackageSubscription } from '#worker/package-invocations/service.ts'
import { listPackageSubscriptions } from '#worker/package-registry/manifest.ts'
import { listSavedPackagesByUserId } from '#worker/package-registry/repo.ts'
import { loadPackageManifestBySourceId } from '#worker/package-registry/source.ts'
import { type SavedPackageRecord } from '#worker/package-registry/types.ts'
import {
	mcpServerDisconnectedTopic,
	mcpServerReconnectedTopic,
	type McpServerConnectionEvent,
	type McpServerConnectionEventTopic,
} from './connection-episodes.ts'
import { listEnabledMcpServerSettingRows } from './settings-repo.ts'
import { type McpServerConnectionState } from './types.ts'

export { mcpServerDisconnectedTopic, mcpServerReconnectedTopic }

export type McpServerConnectionSubscriptionEnvelope = {
	event: McpServerConnectionEventTopic
	event_id: string
	server: {
		id: string
		name: string
		state: McpServerConnectionState
		previous_state: McpServerConnectionState | 'unknown'
		episode_id: string
	}
	observed_at: string
	account_url: string
}

type LoadedMcpServerSubscription = {
	savedPackage: SavedPackageRecord
	subscription: ReturnType<typeof listPackageSubscriptions>[number]
}

export function buildMcpServerAccountUrl(input: {
	baseUrl: string
	serverId: string
}) {
	return `${input.baseUrl}/account/mcp-servers/${input.serverId}`
}

function buildSubscriptionIdempotencyKey(input: {
	topic: McpServerConnectionEventTopic
	episodeId: string
	packageId: string
}) {
	return `mcp-server:${input.topic}:${input.episodeId}:${input.packageId}`
}

function buildEventPayload(input: {
	baseUrl: string
	event: McpServerConnectionEvent
}): McpServerConnectionSubscriptionEnvelope {
	return {
		event: input.event.topic,
		event_id: input.event.eventId,
		server: {
			id: input.event.serverId,
			name: input.event.serverName,
			state: input.event.state,
			previous_state: input.event.previousState,
			episode_id: input.event.episodeId,
		},
		observed_at: input.event.observedAt,
		account_url: buildMcpServerAccountUrl({
			baseUrl: input.baseUrl,
			serverId: input.event.serverId,
		}),
	}
}

async function loadMatchingMcpServerSubscriptions(input: {
	env: Pick<Env, 'APP_DB' | 'BUNDLE_ARTIFACTS_KV'>
	baseUrl: string
	userId: string
	topic: McpServerConnectionEventTopic
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
			subscriptions: [] as Array<LoadedMcpServerSubscription>,
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
			} satisfies LoadedMcpServerSubscription
		}),
	)
	const subscriptions: Array<LoadedMcpServerSubscription> = []
	const discoveryErrors: Array<unknown> = []
	for (const [index, result] of settled.entries()) {
		if (result.status === 'fulfilled') {
			if (result.value) subscriptions.push(result.value)
			continue
		}
		const savedPackage = savedPackages[index]
		console.warn(
			'Failed to load package manifest for MCP server connection subscription',
			{
				sourceId: savedPackage?.sourceId,
				packageId: savedPackage?.id,
				topic: input.topic,
				error: result.reason,
			},
		)
		discoveryErrors.push(result.reason)
	}
	return { subscriptions, discoveryErrors }
}

/**
 * Fan an MCP server connection episode out to the owning user's packages that
 * declare the topic. Best-effort: discovery and invocation infrastructure
 * failures are logged, never thrown. Sibling handler terminal failures are
 * isolated via `Promise.allSettled`.
 *
 * One emit per topic per episode. Packages decide how to notify.
 */
export async function dispatchMcpServerConnectionSubscriptionEvents(input: {
	env: Pick<Env, 'APP_DB' | 'BUNDLE_ARTIFACTS_KV' | 'APP_BASE_URL'>
	userId: string
	event: McpServerConnectionEvent
	waitUntil?: (promise: Promise<unknown>) => void
}) {
	const baseUrl = getAppBaseUrl({ env: input.env })
	const { subscriptions, discoveryErrors } =
		await loadMatchingMcpServerSubscriptions({
			env: input.env,
			baseUrl,
			userId: input.userId,
			topic: input.event.topic,
		})
	const eventPayload = buildEventPayload({
		baseUrl,
		event: input.event,
	})
	const settled = await runWithDynamicWorkerEvaluationBudget(
		async () =>
			await Promise.allSettled(
				subscriptions.map(async ({ savedPackage }) => {
					const response = await invokePackageSubscription({
						env: input.env as Env,
						baseUrl,
						savedPackage,
						topic: input.event.topic,
						params: eventPayload as Record<string, unknown>,
						idempotencyKey: buildSubscriptionIdempotencyKey({
							topic: input.event.topic,
							episodeId: input.event.episodeId,
							packageId: savedPackage.id,
						}),
						source: 'mcp-client',
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
			console.warn('mcp.server connection package subscription invoke failed', {
				eventId: input.event.eventId,
				topic: input.event.topic,
				serverName: input.event.serverName,
				error: result.reason,
			})
		}
	}
	if (discoveryErrors.length > 0) {
		console.warn(
			'mcp.server connection package subscription discovery incomplete',
			{
				eventId: input.event.eventId,
				topic: input.event.topic,
				serverName: input.event.serverName,
				errorCount: discoveryErrors.length,
				error: discoveryErrors[0],
			},
		)
	}
	return settled.map((result) =>
		result.status === 'fulfilled' ? result.value : null,
	)
}

export async function emitMcpServerConnectionEventsIfNeeded(input: {
	env: Env
	userId: string
	events: Array<McpServerConnectionEvent>
	waitUntil?: (promise: Promise<unknown>) => void
}) {
	if (input.events.length === 0) return
	let enabledIds: Set<string>
	try {
		const rows = await listEnabledMcpServerSettingRows({
			db: input.env.APP_DB,
			userId: input.userId,
		})
		enabledIds = new Set(rows.map((row) => row.id))
	} catch (error) {
		console.warn('mcp.server connection event enabled-server lookup failed', {
			error,
		})
		return
	}
	const pending = input.events
		.filter((event) => enabledIds.has(event.serverId))
		.map((event) =>
			dispatchMcpServerConnectionSubscriptionEvents({
				env: input.env,
				userId: input.userId,
				event,
				waitUntil: input.waitUntil,
			}),
		)
	if (pending.length === 0) return
	const all = Promise.all(pending).then(() => undefined)
	if (input.waitUntil) {
		input.waitUntil(all)
		return
	}
	await all
}
