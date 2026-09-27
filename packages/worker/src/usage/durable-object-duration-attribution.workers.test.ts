import { runInDurableObject } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { afterEach, expect, test, vi } from 'vitest'
import { ensureEntitlementTestSchema } from '#worker/entitlements/test-schema.ts'
import { repoSessionStorageBucketId } from '#worker/storage-buckets/service.ts'
import { ensureUserStorageBucketsTestSchema } from '#worker/storage-buckets/test-schema.ts'
import { ensurePackageSubscriptionTestSchema } from '#worker/test-support/workers-seed.ts'
import { createStableUserIdFromEmail } from '#worker/user-id.ts'
import {
	runLogDurableObjectName,
	storageRunnerDurableObjectName,
} from '#worker/user-scoped-durable-object-name.ts'
import {
	buildDurableObjectOwnerMap,
	runDurableObjectDurationAttribution,
} from './durable-object-duration-attribution.ts'

afterEach(() => {
	vi.unstubAllGlobals()
})

async function ensureSchema() {
	await ensureEntitlementTestSchema(env.APP_DB)
	await ensureUserStorageBucketsTestSchema(env.APP_DB)
	await ensurePackageSubscriptionTestSchema(env.APP_DB)
	await env.APP_DB.batch([
		env.APP_DB
			.prepare(`CREATE TABLE IF NOT EXISTS durable_object_duration_daily (
	user_id TEXT NOT NULL,
	do_class TEXT NOT NULL,
	day TEXT NOT NULL,
	active_ms INTEGER NOT NULL,
	object_count INTEGER NOT NULL,
	updated_at TEXT NOT NULL,
	PRIMARY KEY (user_id, do_class, day)
)`),
		env.APP_DB
			.prepare(`CREATE TABLE IF NOT EXISTS durable_object_duration_coverage_daily (
	day TEXT PRIMARY KEY,
	total_active_ms INTEGER NOT NULL,
	attributed_active_ms INTEGER NOT NULL,
	object_count INTEGER NOT NULL,
	attributed_object_count INTEGER NOT NULL,
	truncated INTEGER NOT NULL DEFAULT 0,
	updated_at TEXT NOT NULL
)`),
	])
}

async function seedUser() {
	const email = `do-duration-${crypto.randomUUID()}@example.com`
	const userId = await createStableUserIdFromEmail(email)
	await env.APP_DB.prepare(
		`INSERT INTO users (username, email, password_hash, stable_user_id)
		 VALUES (?, ?, 'hash', ?)`,
	)
		.bind(`dod-${crypto.randomUUID().slice(0, 8)}`, email, userId)
		.run()
	return userId
}

test('owner map object ids match the ids the Durable Objects themselves see', async () => {
	await ensureSchema()
	const userId = await seedUser()
	const storageId = `package:${crypto.randomUUID()}`
	await env.APP_DB.prepare(
		`INSERT INTO user_storage_buckets (user_id, storage_id, kind, created_at, last_seen_at)
		 VALUES (?, ?, 'package', ?, ?)`,
	)
		.bind(userId, storageId, new Date().toISOString(), new Date().toISOString())
		.run()
	const repoSessionId = crypto.randomUUID()
	await env.APP_DB.prepare(
		`INSERT INTO user_storage_buckets (user_id, storage_id, kind, created_at, last_seen_at)
		 VALUES (?, ?, 'repo_session', ?, ?)`,
	)
		.bind(
			userId,
			repoSessionStorageBucketId(repoSessionId),
			new Date().toISOString(),
			new Date().toISOString(),
		)
		.run()

	const owners = await buildDurableObjectOwnerMap(env)
	const runLog = env.RUN_LOG.get(
		env.RUN_LOG.idFromName(runLogDurableObjectName(userId)),
	)
	await runInDurableObject(runLog, (_instance, state) => {
		expect(owners.get(state.id.toString())).toEqual({
			userId,
			doClass: 'RunLog',
		})
	})
	const storage = env.STORAGE_RUNNER.get(
		env.STORAGE_RUNNER.idFromName(
			storageRunnerDurableObjectName(userId, storageId),
		),
	)
	await runInDurableObject(storage, (_instance, state) => {
		expect(owners.get(state.id.toString())).toEqual({
			userId,
			doClass: 'StorageRunner',
		})
	})
	expect(
		owners.get(env.REPO_SESSION.idFromName(repoSessionId).toString()),
	).toEqual({ userId, doClass: 'RepoSession' })
})

test('the lane stores attributed daily active time and fleet coverage', async () => {
	await ensureSchema()
	const userId = await seedUser()
	const hubId = env.MCP_CLIENT_HUB.idFromName(userId).toString()
	vi.stubGlobal(
		'fetch',
		vi.fn(async (_url: string, init: RequestInit) => {
			const { variables } = JSON.parse(String(init.body)) as {
				variables: { day: string }
			}
			const groups =
				variables.day === '2026-09-26'
					? [
							{
								dimensions: { objectId: hubId },
								sum: { activeTime: 7_200_000_000 },
							},
							{
								dimensions: { objectId: 'f'.repeat(64) },
								sum: { activeTime: 800_000_000 },
							},
						]
					: []
			return new Response(
				JSON.stringify({
					data: {
						viewer: { accounts: [{ durableObjectsPeriodicGroups: groups }] },
					},
				}),
			)
		}),
	)
	const workerEnv = {
		...env,
		CLOUDFLARE_ACCOUNT_ID: 'acct',
		CLOUDFLARE_API_TOKEN: 'token',
	}
	await runDurableObjectDurationAttribution({
		env: workerEnv,
		now: new Date('2026-09-27T03:20:00.000Z'),
	})
	// Rerunning the same hour overwrites instead of adding.
	await runDurableObjectDurationAttribution({
		env: workerEnv,
		now: new Date('2026-09-27T04:20:00.000Z'),
	})
	expect(
		await env.APP_DB.prepare(
			`SELECT do_class, active_ms, object_count FROM durable_object_duration_daily
			 WHERE user_id = ? AND day = '2026-09-26'`,
		)
			.bind(userId)
			.all(),
	).toMatchObject({
		results: [
			{ do_class: 'McpClientHub', active_ms: 7_200_000, object_count: 1 },
		],
	})
	expect(
		await env.APP_DB.prepare(
			`SELECT total_active_ms, attributed_active_ms, object_count, attributed_object_count
			 FROM durable_object_duration_coverage_daily WHERE day = '2026-09-26'`,
		).first(),
	).toEqual({
		total_active_ms: 8_000_000,
		attributed_active_ms: 7_200_000,
		object_count: 2,
		attributed_object_count: 1,
	})
})

test('a user whose deletion starts mid-run gets no duration rows', async () => {
	await ensureSchema()
	const userId = await seedUser()
	const hubId = env.MCP_CLIENT_HUB.idFromName(userId).toString()
	vi.stubGlobal(
		'fetch',
		vi.fn(async () => {
			await env.APP_DB.prepare(
				`UPDATE users SET deleting_at = ? WHERE stable_user_id = ?`,
			)
				.bind(new Date().toISOString(), userId)
				.run()
			return new Response(
				JSON.stringify({
					data: {
						viewer: {
							accounts: [
								{
									durableObjectsPeriodicGroups: [
										{
											dimensions: { objectId: hubId },
											sum: { activeTime: 1_000_000 },
										},
									],
								},
							],
						},
					},
				}),
			)
		}),
	)
	await runDurableObjectDurationAttribution({
		env: {
			...env,
			CLOUDFLARE_ACCOUNT_ID: 'acct',
			CLOUDFLARE_API_TOKEN: 'token',
		},
		now: new Date('2026-09-27T03:20:00.000Z'),
	})
	expect(
		await env.APP_DB.prepare(
			`SELECT COUNT(*) AS count FROM durable_object_duration_daily WHERE user_id = ?`,
		)
			.bind(userId)
			.first(),
	).toEqual({ count: 0 })
})
