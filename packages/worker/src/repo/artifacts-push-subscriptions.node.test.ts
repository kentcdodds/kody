import { DatabaseSync } from 'node:sqlite'
import { expect, test, vi } from 'vitest'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { silenceExpectedConsoleWarns } from '#worker/test-support/console-spies.ts'
import { insertEntitySource } from './entity-sources.ts'
import {
	ensureArtifactsRepoPushSubscription,
	resetArtifactsRepoEventsQueueIdCache,
} from './artifacts-push-subscriptions.ts'
import { getArtifactsPushSubscriptionBySourceId } from './artifacts-push-subscription-store.ts'

const accountId = 'acct'
const apiOrigin = 'https://api.example.com'
const queueId = 'queue-artifacts-repo-events'
const repoName = 'package-package-1'
const subscriptionName = 'kody-push-default-package-package-1'
const sourceId = 'source-1'
const userId = 'user-1'

function jsonResponse(status: number, body: unknown) {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'content-type': 'application/json' },
	})
}

function queueListBody() {
	return {
		success: true,
		result: [
			{ queue_id: 'queue-other', queue_name: 'kody-email-delivery' },
			{ queue_id: queueId, queue_name: 'kody-artifacts-repo-events' },
		],
		result_info: { total_pages: 1 },
	}
}

function subscriptionRecord(id: string, destinationQueueId = queueId) {
	return {
		id,
		name: subscriptionName,
		enabled: true,
		events: ['pushed'],
		source: {
			type: 'artifacts.repo',
			namespace: 'default',
			repo_name: repoName,
		},
		destination: { type: 'queues.queue', queue_id: destinationQueueId },
	}
}

function createDb() {
	const sqlite = new DatabaseSync(':memory:')
	sqlite.exec(`
		CREATE TABLE entity_sources (
			id TEXT PRIMARY KEY,
			user_id TEXT NOT NULL,
			entity_kind TEXT NOT NULL,
			entity_id TEXT NOT NULL,
			repo_id TEXT NOT NULL,
			published_commit TEXT,
			indexed_commit TEXT,
			manifest_path TEXT NOT NULL DEFAULT 'kody.json',
			source_root TEXT NOT NULL DEFAULT '/',
			last_external_check_at TEXT,
			external_check_until TEXT,
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL
		);
		CREATE TABLE entity_source_artifacts_push_subscriptions (
			source_id TEXT PRIMARY KEY NOT NULL,
			user_id TEXT NOT NULL,
			repo_id TEXT NOT NULL,
			subscription_id TEXT NOT NULL,
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL
		);
	`)
	return createD1FromSqlite(sqlite)
}

async function seedSource(db: D1Database) {
	await insertEntitySource(db, {
		id: sourceId,
		user_id: userId,
		entity_kind: 'package',
		entity_id: 'package-1',
		repo_id: repoName,
		published_commit: null,
		indexed_commit: null,
		manifest_path: 'package.json',
		source_root: '/',
		last_external_check_at: null,
		external_check_until: null,
		created_at: '2026-05-01T00:00:00.000Z',
		updated_at: '2026-05-01T00:00:00.000Z',
	})
}

function createEnv(db: D1Database) {
	return {
		APP_DB: db,
		CLOUDFLARE_ACCOUNT_ID: accountId,
		CLOUDFLARE_API_TOKEN: 'token-123',
		CLOUDFLARE_API_BASE_URL: apiOrigin,
		ARTIFACTS_NAMESPACE: 'default',
	} as Env
}

function requestKey(method: string, pathname: string) {
	return `${method} ${pathname}`
}

test('ensureArtifactsRepoPushSubscription posts without listing and caches the queue id', async () => {
	resetArtifactsRepoEventsQueueIdCache()
	const db = createDb()
	await seedSource(db)
	const calls: Array<string> = []
	const fetchMock = vi
		.spyOn(globalThis, 'fetch')
		.mockImplementation(async (input, init) => {
			const url = new URL(String(input))
			const method = init?.method ?? 'GET'
			calls.push(requestKey(method, url.pathname))
			if (
				method === 'GET' &&
				url.pathname === `/client/v4/accounts/${accountId}/queues`
			) {
				return jsonResponse(200, queueListBody())
			}
			if (
				method === 'POST' &&
				url.pathname ===
					`/client/v4/accounts/${accountId}/event_subscriptions/subscriptions`
			) {
				return jsonResponse(200, {
					success: true,
					result: subscriptionRecord('sub-1'),
				})
			}
			if (
				method === 'GET' &&
				url.pathname ===
					`/client/v4/accounts/${accountId}/event_subscriptions/subscriptions/sub-1`
			) {
				return jsonResponse(200, {
					success: true,
					result: subscriptionRecord('sub-1'),
				})
			}
			throw new Error(`Unexpected fetch: ${method} ${url.pathname}`)
		})

	try {
		const first = await ensureArtifactsRepoPushSubscription({
			env: createEnv(db),
			userId,
			sourceId,
			repoName,
		})
		expect(first).toEqual({ subscriptionId: 'sub-1', skipped: false })
		await expect(
			getArtifactsPushSubscriptionBySourceId(db, sourceId),
		).resolves.toMatchObject({ subscription_id: 'sub-1' })
		expect(calls).toEqual([
			requestKey('GET', `/client/v4/accounts/${accountId}/queues`),
			requestKey(
				'POST',
				`/client/v4/accounts/${accountId}/event_subscriptions/subscriptions`,
			),
		])

		const second = await ensureArtifactsRepoPushSubscription({
			env: createEnv(db),
			userId,
			sourceId,
			repoName,
		})
		expect(second).toEqual({ subscriptionId: 'sub-1', skipped: false })
		expect(calls).toEqual([
			requestKey('GET', `/client/v4/accounts/${accountId}/queues`),
			requestKey(
				'POST',
				`/client/v4/accounts/${accountId}/event_subscriptions/subscriptions`,
			),
			requestKey(
				'GET',
				`/client/v4/accounts/${accountId}/event_subscriptions/subscriptions/sub-1`,
			),
		])

		await db
			.prepare(
				`DELETE FROM entity_source_artifacts_push_subscriptions WHERE source_id = ?`,
			)
			.bind(sourceId)
			.run()
		const third = await ensureArtifactsRepoPushSubscription({
			env: createEnv(db),
			userId,
			sourceId,
			repoName,
		})
		expect(third).toEqual({ subscriptionId: 'sub-1', skipped: false })
		expect(
			calls.filter(
				(call) => call.startsWith('GET ') && call.endsWith('/queues'),
			),
		).toHaveLength(1)
		expect(calls.filter((call) => call.startsWith('POST '))).toHaveLength(2)
		expect(
			calls.some(
				(call) =>
					call.endsWith('/event_subscriptions/subscriptions') &&
					call.startsWith('GET '),
			),
		).toBe(false)
	} finally {
		fetchMock.mockRestore()
		resetArtifactsRepoEventsQueueIdCache()
	}
})

test('ensureArtifactsRepoPushSubscription reuses an existing subscription on create conflict', async () => {
	resetArtifactsRepoEventsQueueIdCache()
	const db = createDb()
	await seedSource(db)
	const calls: Array<string> = []
	const fetchMock = vi
		.spyOn(globalThis, 'fetch')
		.mockImplementation(async (input, init) => {
			const url = new URL(String(input))
			const method = init?.method ?? 'GET'
			calls.push(requestKey(method, url.pathname))
			if (
				method === 'GET' &&
				url.pathname === `/client/v4/accounts/${accountId}/queues`
			) {
				return jsonResponse(200, queueListBody())
			}
			if (
				method === 'POST' &&
				url.pathname ===
					`/client/v4/accounts/${accountId}/event_subscriptions/subscriptions`
			) {
				return jsonResponse(409, {
					success: false,
					result: null,
					errors: [{ code: 1003, message: 'subscription already exists' }],
				})
			}
			if (
				method === 'GET' &&
				url.pathname ===
					`/client/v4/accounts/${accountId}/event_subscriptions/subscriptions`
			) {
				return jsonResponse(200, {
					success: true,
					result: [subscriptionRecord('sub-existing')],
					result_info: { total_pages: 1 },
				})
			}
			throw new Error(`Unexpected fetch: ${method} ${url.pathname}`)
		})

	try {
		const result = await ensureArtifactsRepoPushSubscription({
			env: createEnv(db),
			userId,
			sourceId,
			repoName,
		})
		expect(result).toEqual({
			subscriptionId: 'sub-existing',
			skipped: false,
		})
		await expect(
			getArtifactsPushSubscriptionBySourceId(db, sourceId),
		).resolves.toMatchObject({ subscription_id: 'sub-existing' })
		expect(calls).toEqual([
			requestKey('GET', `/client/v4/accounts/${accountId}/queues`),
			requestKey(
				'POST',
				`/client/v4/accounts/${accountId}/event_subscriptions/subscriptions`,
			),
			requestKey(
				'GET',
				`/client/v4/accounts/${accountId}/event_subscriptions/subscriptions`,
			),
		])
	} finally {
		fetchMock.mockRestore()
		resetArtifactsRepoEventsQueueIdCache()
	}
})

test('ensureArtifactsRepoPushSubscription skips a name conflict that belongs to a different source', async () => {
	resetArtifactsRepoEventsQueueIdCache()
	silenceExpectedConsoleWarns(['artifacts-push-subscription-ensure-failed'])
	const db = createDb()
	await seedSource(db)
	const calls: Array<string> = []
	const fetchMock = vi
		.spyOn(globalThis, 'fetch')
		.mockImplementation(async (input, init) => {
			const url = new URL(String(input))
			const method = init?.method ?? 'GET'
			calls.push(requestKey(method, url.pathname))
			if (
				method === 'GET' &&
				url.pathname === `/client/v4/accounts/${accountId}/queues`
			) {
				return jsonResponse(200, queueListBody())
			}
			if (
				method === 'POST' &&
				url.pathname ===
					`/client/v4/accounts/${accountId}/event_subscriptions/subscriptions`
			) {
				return jsonResponse(409, {
					success: false,
					result: null,
					errors: [{ code: 1003, message: 'subscription already exists' }],
				})
			}
			if (
				method === 'GET' &&
				url.pathname ===
					`/client/v4/accounts/${accountId}/event_subscriptions/subscriptions`
			) {
				return jsonResponse(200, {
					success: true,
					result: [
						{
							...subscriptionRecord('sub-other'),
							source: {
								type: 'artifacts.repo',
								namespace: 'default',
								repo_name: 'package-other-repo',
							},
						},
					],
					result_info: { total_pages: 1 },
				})
			}
			throw new Error(`Unexpected fetch: ${method} ${url.pathname}`)
		})

	try {
		const result = await ensureArtifactsRepoPushSubscription({
			env: createEnv(db),
			userId,
			sourceId,
			repoName,
		})
		expect(result).toEqual({ subscriptionId: null, skipped: true })
		await expect(
			getArtifactsPushSubscriptionBySourceId(db, sourceId),
		).resolves.toBeNull()
		expect(calls.some((call) => call.startsWith('DELETE '))).toBe(false)
	} finally {
		fetchMock.mockRestore()
		resetArtifactsRepoEventsQueueIdCache()
	}
})

test('ensureArtifactsRepoPushSubscription does not persist when the source is deleted during create', async () => {
	resetArtifactsRepoEventsQueueIdCache()
	const db = createDb()
	await seedSource(db)
	const calls: Array<string> = []
	const fetchMock = vi
		.spyOn(globalThis, 'fetch')
		.mockImplementation(async (input, init) => {
			const url = new URL(String(input))
			const method = init?.method ?? 'GET'
			calls.push(requestKey(method, url.pathname))
			if (
				method === 'GET' &&
				url.pathname === `/client/v4/accounts/${accountId}/queues`
			) {
				return jsonResponse(200, queueListBody())
			}
			if (
				method === 'POST' &&
				url.pathname ===
					`/client/v4/accounts/${accountId}/event_subscriptions/subscriptions`
			) {
				await db
					.prepare(`DELETE FROM entity_sources WHERE id = ?`)
					.bind(sourceId)
					.run()
				return jsonResponse(200, {
					success: true,
					result: subscriptionRecord('sub-1'),
				})
			}
			if (
				method === 'DELETE' &&
				url.pathname ===
					`/client/v4/accounts/${accountId}/event_subscriptions/subscriptions/sub-1`
			) {
				return jsonResponse(200, { success: true, result: null })
			}
			throw new Error(`Unexpected fetch: ${method} ${url.pathname}`)
		})

	try {
		const result = await ensureArtifactsRepoPushSubscription({
			env: createEnv(db),
			userId,
			sourceId,
			repoName,
		})
		expect(result).toEqual({ subscriptionId: null, skipped: true })
		await expect(
			getArtifactsPushSubscriptionBySourceId(db, sourceId),
		).resolves.toBeNull()
		expect(calls).toContain(
			requestKey(
				'DELETE',
				`/client/v4/accounts/${accountId}/event_subscriptions/subscriptions/sub-1`,
			),
		)
	} finally {
		fetchMock.mockRestore()
		resetArtifactsRepoEventsQueueIdCache()
	}
})
