import {
	CloudflareApiError,
	createCloudflareRestClient,
} from '#mcp/cloudflare/cloudflare-rest-client.ts'
import { getArtifactsNamespace, hasArtifactsAccess } from './artifacts.ts'
import { artifactsRepoEventsQueueName } from './artifacts-event-queue-names.ts'
import { isSessionArtifactRepoName } from './artifacts-events.ts'
import {
	deleteArtifactsPushSubscriptionBySourceId,
	getArtifactsPushSubscriptionBySourceId,
	upsertArtifactsPushSubscription,
} from './artifacts-push-subscription-store.ts'
import { getEntitySourceById } from './entity-sources.ts'

type CloudflareQueueListItem = {
	queue_id?: string
	queue_name?: string
}

type CloudflareEventSubscription = {
	id: string
	name: string
	enabled: boolean
	events: Array<string>
	source: Record<string, unknown>
	destination: {
		type: string
		queue_id: string
	}
}

const pushEventTypes = ['pushed'] as const
const subscriptionNameMaxLen = 63

function buildPushSubscriptionName(input: {
	namespace: string
	repoName: string
}) {
	const suffix = `-${input.namespace}-${input.repoName}`
	const prefix = 'kody-push'
	if (prefix.length + suffix.length <= subscriptionNameMaxLen) {
		return `${prefix}${suffix}`
	}
	const available = subscriptionNameMaxLen - prefix.length
	const trimmedSuffix = suffix.slice(-available)
	return `${prefix}${trimmedSuffix}`
}

function readCloudflareResult<T>(body: unknown): T | null {
	if (!body || typeof body !== 'object' || Array.isArray(body)) return null
	const record = body as Record<string, unknown>
	if (record['success'] !== true) return null
	return (record['result'] as T | undefined) ?? null
}

async function resolveArtifactsRepoEventsQueueId(
	env: Env,
): Promise<string | null> {
	const accountId = env.CLOUDFLARE_ACCOUNT_ID?.trim()
	const apiToken = env.CLOUDFLARE_API_TOKEN?.trim()
	if (!accountId || !apiToken) return null
	const client = createCloudflareRestClient(env)
	let page = 1
	let totalPages = 1
	do {
		const response = await client.rawRequest({
			method: 'GET',
			path: `/client/v4/accounts/${encodeURIComponent(accountId)}/queues`,
			query: { page: String(page), per_page: '100' },
		})
		if (response.status >= 400) {
			throw new CloudflareApiError(
				`Failed to list Cloudflare Queues (${response.status}).`,
				{ status: response.status },
			)
		}
		const result = readCloudflareResult<Array<CloudflareQueueListItem>>(
			response.body,
		)
		const match = (result ?? []).find(
			(queue) => queue.queue_name === artifactsRepoEventsQueueName,
		)
		if (match?.queue_id) {
			return match.queue_id
		}
		const info =
			response.body &&
			typeof response.body === 'object' &&
			!Array.isArray(response.body)
				? (response.body as Record<string, unknown>)['result_info']
				: null
		totalPages =
			info && typeof info === 'object' && !Array.isArray(info)
				? Math.max(
						1,
						Number((info as Record<string, unknown>)['total_pages'] ?? 1),
					)
				: 1
		page += 1
	} while (page <= totalPages)
	return null
}

async function listEventSubscriptions(env: Env, accountId: string) {
	const client = createCloudflareRestClient(env)
	const subscriptions: Array<CloudflareEventSubscription> = []
	let page = 1
	let totalPages = 1
	do {
		const response = await client.rawRequest({
			method: 'GET',
			path: `/client/v4/accounts/${encodeURIComponent(accountId)}/event_subscriptions/subscriptions`,
			query: { page: String(page), per_page: '100' },
		})
		if (response.status >= 400) {
			throw new CloudflareApiError(
				`Failed to list Cloudflare event subscriptions (${response.status}).`,
				{ status: response.status },
			)
		}
		const result = readCloudflareResult<Array<CloudflareEventSubscription>>(
			response.body,
		)
		subscriptions.push(...(result ?? []))
		const info =
			response.body &&
			typeof response.body === 'object' &&
			!Array.isArray(response.body)
				? (response.body as Record<string, unknown>)['result_info']
				: null
		totalPages =
			info && typeof info === 'object' && !Array.isArray(info)
				? Math.max(
						1,
						Number((info as Record<string, unknown>)['total_pages'] ?? 1),
					)
				: 1
		page += 1
	} while (page <= totalPages)
	return subscriptions
}

async function artifactsEventSubscriptionExists(input: {
	env: Env
	accountId: string
	subscriptionId: string
}) {
	const client = createCloudflareRestClient(input.env)
	const response = await client.rawRequest({
		method: 'GET',
		path: `/client/v4/accounts/${encodeURIComponent(input.accountId)}/event_subscriptions/subscriptions/${encodeURIComponent(input.subscriptionId)}`,
	})
	if (response.status === 404) return false
	if (response.status >= 400) {
		throw new CloudflareApiError(
			`Failed to read Cloudflare event subscription (${response.status}).`,
			{ status: response.status },
		)
	}
	return (
		readCloudflareResult<CloudflareEventSubscription>(response.body) != null
	)
}

function sameStringSet(
	left: ReadonlyArray<string>,
	right: ReadonlyArray<string>,
) {
	return (
		left.length === right.length &&
		new Set(left).size === new Set(right).size &&
		left.every((value) => right.includes(value))
	)
}

/**
 * Ensure a repository-level Cloudflare Artifacts push event subscription exists
 * for a durable entity source Artifacts repo. Session forks are skipped.
 * Best-effort: missing Queues credentials, the destination queue, or Cloudflare
 * API failures return without throwing so source creation still succeeds.
 */
export async function ensureArtifactsRepoPushSubscription(input: {
	env: Env
	userId: string
	sourceId: string
	repoName: string
}): Promise<{ subscriptionId: string | null; skipped: boolean }> {
	try {
		return await ensureArtifactsRepoPushSubscriptionUnsafe(input)
	} catch (error) {
		console.warn('artifacts-push-subscription-ensure-failed', {
			sourceId: input.sourceId,
			repoName: input.repoName,
			error,
		})
		return { subscriptionId: null, skipped: true }
	}
}

async function ensureArtifactsRepoPushSubscriptionUnsafe(input: {
	env: Env
	userId: string
	sourceId: string
	repoName: string
}): Promise<{ subscriptionId: string | null; skipped: boolean }> {
	const repoName = input.repoName.trim()
	if (!repoName || isSessionArtifactRepoName(repoName)) {
		return { subscriptionId: null, skipped: true }
	}
	if (!hasArtifactsAccess(input.env)) {
		return { subscriptionId: null, skipped: true }
	}
	const accountId = input.env.CLOUDFLARE_ACCOUNT_ID?.trim()
	if (!accountId) return { subscriptionId: null, skipped: true }

	const existingSource = await getEntitySourceById(
		input.env.APP_DB,
		input.sourceId,
	)
	if (!existingSource || existingSource.user_id !== input.userId) {
		return { subscriptionId: null, skipped: true }
	}
	const stored = await getArtifactsPushSubscriptionBySourceId(
		input.env.APP_DB,
		input.sourceId,
	)
	if (stored?.subscription_id) {
		const stillExists = await artifactsEventSubscriptionExists({
			env: input.env,
			accountId,
			subscriptionId: stored.subscription_id,
		})
		if (stillExists) {
			return { subscriptionId: stored.subscription_id, skipped: false }
		}
		await deleteArtifactsPushSubscriptionBySourceId(input.env.APP_DB, {
			sourceId: input.sourceId,
			userId: input.userId,
		})
	}

	const queueId = await resolveArtifactsRepoEventsQueueId(input.env)
	if (!queueId) {
		return { subscriptionId: null, skipped: true }
	}

	const namespace = getArtifactsNamespace(input.env)
	const name = buildPushSubscriptionName({ namespace, repoName })
	const subscriptions = await listEventSubscriptions(input.env, accountId)
	const existing = subscriptions.find(
		(subscription) => subscription.name === name,
	)
	const events = [...pushEventTypes]
	const sourceIsCurrent =
		existing?.source['type'] === 'artifacts.repo' &&
		existing.source['namespace'] === namespace &&
		(existing.source['repo_name'] === repoName ||
			existing.source['repoName'] === repoName)
	const isCurrent =
		existing?.enabled === true &&
		existing.destination.type === 'queues.queue' &&
		existing.destination.queue_id === queueId &&
		sourceIsCurrent &&
		sameStringSet(existing.events, events)

	const client = createCloudflareRestClient(input.env)
	let subscriptionId: string
	if (existing && isCurrent) {
		subscriptionId = existing.id
	} else if (existing && sourceIsCurrent) {
		const response = await client.rawRequest({
			method: 'PATCH',
			path: `/client/v4/accounts/${encodeURIComponent(accountId)}/event_subscriptions/subscriptions/${encodeURIComponent(existing.id)}`,
			body: {
				name,
				enabled: true,
				destination: { type: 'queues.queue', queue_id: queueId },
				events,
			},
		})
		if (response.status >= 400) {
			throw new CloudflareApiError(
				`Failed to update Artifacts push event subscription (${response.status}).`,
				{ status: response.status },
			)
		}
		const result = readCloudflareResult<CloudflareEventSubscription>(
			response.body,
		)
		subscriptionId = result?.id ?? existing.id
	} else {
		if (existing) {
			await client.rawRequest({
				method: 'DELETE',
				path: `/client/v4/accounts/${encodeURIComponent(accountId)}/event_subscriptions/subscriptions/${encodeURIComponent(existing.id)}`,
			})
		}
		const response = await client.rawRequest({
			method: 'POST',
			path: `/client/v4/accounts/${encodeURIComponent(accountId)}/event_subscriptions/subscriptions`,
			body: {
				name,
				enabled: true,
				source: {
					type: 'artifacts.repo',
					namespace,
					repo_name: repoName,
				},
				destination: { type: 'queues.queue', queue_id: queueId },
				events,
			},
		})
		if (response.status >= 400) {
			throw new CloudflareApiError(
				`Failed to create Artifacts push event subscription (${response.status}).`,
				{ status: response.status },
			)
		}
		const result = readCloudflareResult<CloudflareEventSubscription>(
			response.body,
		)
		if (!result?.id) {
			throw new Error(
				`Cloudflare created Artifacts push event subscription without an id: ${name}`,
			)
		}
		subscriptionId = result.id
	}

	const now = new Date().toISOString()
	await upsertArtifactsPushSubscription(input.env.APP_DB, {
		source_id: input.sourceId,
		user_id: input.userId,
		repo_id: repoName,
		subscription_id: subscriptionId,
		created_at: now,
		updated_at: now,
	})
	return { subscriptionId, skipped: false }
}

export async function deleteArtifactsRepoPushSubscription(input: {
	env: Env
	subscriptionId?: string | null
	repoName?: string | null
}): Promise<boolean> {
	const accountId = input.env.CLOUDFLARE_ACCOUNT_ID?.trim()
	const apiToken = input.env.CLOUDFLARE_API_TOKEN?.trim()
	if (!accountId || !apiToken) return false

	const client = createCloudflareRestClient(input.env)
	let subscriptionId = input.subscriptionId?.trim() || null
	if (!subscriptionId && input.repoName?.trim()) {
		const namespace = getArtifactsNamespace(input.env)
		const name = buildPushSubscriptionName({
			namespace,
			repoName: input.repoName.trim(),
		})
		const subscriptions = await listEventSubscriptions(input.env, accountId)
		subscriptionId =
			subscriptions.find((entry) => entry.name === name)?.id ?? null
	}
	if (!subscriptionId) return false

	const response = await client.rawRequest({
		method: 'DELETE',
		path: `/client/v4/accounts/${encodeURIComponent(accountId)}/event_subscriptions/subscriptions/${encodeURIComponent(subscriptionId)}`,
	})
	if (response.status === 404) return false
	if (response.status >= 400) {
		throw new CloudflareApiError(
			`Failed to delete Artifacts push event subscription (${response.status}).`,
			{ status: response.status },
		)
	}
	return true
}
