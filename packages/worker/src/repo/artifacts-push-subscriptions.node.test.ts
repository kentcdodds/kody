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

const queuesPath = `/client/v4/accounts/${accountId}/queues`
const subscriptionsPath = `/client/v4/accounts/${accountId}/event_subscriptions/subscriptions`

function jsonResponse(status: number, body: unknown) {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'content-type': 'application/json' },
	})
}

const queueList = () =>
	jsonResponse(200, {
		success: true,
		result: [
			{ queue_id: 'queue-other', queue_name: 'kody-email-delivery' },
			{ queue_id: queueId, queue_name: 'kody-artifacts-repo-events' },
		],
		result_info: { total_pages: 1 },
	})

const createConflict = () =>
	jsonResponse(409, {
		success: false,
		result: null,
		errors: [{ code: 1003, message: 'subscription already exists' }],
	})

const subscriptionList = (...records: Array<unknown>) =>
	jsonResponse(200, {
		success: true,
		result: records,
		result_info: { total_pages: 1 },
	})

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
	} as unknown as Env
}

type Route = () => Response | Promise<Response>

async function setup(routes: Record<string, Route>) {
	resetArtifactsRepoEventsQueueIdCache()
	const db = createDb()
	await seedSource(db)
	const calls: Array<string> = []
	vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
		const url = new URL(String(input))
		const call = `${init?.method ?? 'GET'} ${url.pathname}`
		calls.push(call)
		const route = routes[call]
		if (!route) throw new Error(`Unexpected fetch: ${call}`)
		return route()
	})
	const ensure = () =>
		ensureArtifactsRepoPushSubscription({
			env: createEnv(db),
			userId,
			sourceId,
			repoName,
		})
	const stored = () => getArtifactsPushSubscriptionBySourceId(db, sourceId)
	return { db, calls, ensure, stored }
}

const created = () =>
	jsonResponse(200, { success: true, result: subscriptionRecord('sub-1') })

test('ensureArtifactsRepoPushSubscription posts without listing and caches the queue id', async () => {
	const { db, calls, ensure, stored } = await setup({
		[`GET ${queuesPath}`]: queueList,
		[`POST ${subscriptionsPath}`]: created,
		[`GET ${subscriptionsPath}/sub-1`]: created,
	})

	await expect(ensure()).resolves.toEqual({
		subscriptionId: 'sub-1',
		skipped: false,
	})
	await expect(stored()).resolves.toMatchObject({ subscription_id: 'sub-1' })
	expect(calls).toEqual([`GET ${queuesPath}`, `POST ${subscriptionsPath}`])

	await expect(ensure()).resolves.toEqual({
		subscriptionId: 'sub-1',
		skipped: false,
	})
	expect(calls).toEqual([
		`GET ${queuesPath}`,
		`POST ${subscriptionsPath}`,
		`GET ${subscriptionsPath}/sub-1`,
	])

	await db
		.prepare(
			`DELETE FROM entity_source_artifacts_push_subscriptions WHERE source_id = ?`,
		)
		.bind(sourceId)
		.run()
	await expect(ensure()).resolves.toEqual({
		subscriptionId: 'sub-1',
		skipped: false,
	})
	expect(calls).toEqual([
		`GET ${queuesPath}`,
		`POST ${subscriptionsPath}`,
		`GET ${subscriptionsPath}/sub-1`,
		`POST ${subscriptionsPath}`,
	])
})

test('ensureArtifactsRepoPushSubscription reuses an existing subscription on create conflict', async () => {
	const { calls, ensure, stored } = await setup({
		[`GET ${queuesPath}`]: queueList,
		[`POST ${subscriptionsPath}`]: createConflict,
		[`GET ${subscriptionsPath}`]: () =>
			subscriptionList(subscriptionRecord('sub-existing')),
	})

	await expect(ensure()).resolves.toEqual({
		subscriptionId: 'sub-existing',
		skipped: false,
	})
	await expect(stored()).resolves.toMatchObject({
		subscription_id: 'sub-existing',
	})
	expect(calls).toEqual([
		`GET ${queuesPath}`,
		`POST ${subscriptionsPath}`,
		`GET ${subscriptionsPath}`,
	])
})

test('ensureArtifactsRepoPushSubscription skips a name conflict that belongs to a different source', async () => {
	silenceExpectedConsoleWarns(['artifacts-push-subscription-ensure-failed'])
	const { calls, ensure, stored } = await setup({
		[`GET ${queuesPath}`]: queueList,
		[`POST ${subscriptionsPath}`]: createConflict,
		[`GET ${subscriptionsPath}`]: () =>
			subscriptionList({
				...subscriptionRecord('sub-other'),
				source: {
					type: 'artifacts.repo',
					namespace: 'default',
					repo_name: 'package-other-repo',
				},
			}),
	})

	await expect(ensure()).resolves.toEqual({
		subscriptionId: null,
		skipped: true,
	})
	await expect(stored()).resolves.toBeNull()
	expect(calls.some((call) => call.startsWith('DELETE '))).toBe(false)
})

test('ensureArtifactsRepoPushSubscription does not persist when the source is deleted during create', async () => {
	const { db, calls, ensure, stored } = await setup({
		[`GET ${queuesPath}`]: queueList,
		[`POST ${subscriptionsPath}`]: async () => {
			await db
				.prepare(`DELETE FROM entity_sources WHERE id = ?`)
				.bind(sourceId)
				.run()
			return created()
		},
		[`DELETE ${subscriptionsPath}/sub-1`]: () =>
			jsonResponse(200, { success: true, result: null }),
	})

	await expect(ensure()).resolves.toEqual({
		subscriptionId: null,
		skipped: true,
	})
	await expect(stored()).resolves.toBeNull()
	expect(calls).toContain(`DELETE ${subscriptionsPath}/sub-1`)
})
