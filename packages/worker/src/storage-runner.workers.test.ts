import { env } from 'cloudflare:workers'
import { runInDurableObject } from 'cloudflare:test'
import { expect, test } from 'vitest'
import { EntitlementLimitError } from '#worker/entitlements/errors.ts'
import { planLimits } from '#worker/entitlements/plans.ts'
import { readUserD1StorageBytes } from '#worker/entitlements/service.ts'
import { ensureEntitlementTestSchema } from '#worker/entitlements/test-schema.ts'
import {
	clearStorageBucketRegistrationDedupeForTests,
	flushStorageBucketRegistrationsForTests,
	listUserStorageBucketEstimates,
	listUserStorageBucketIds,
} from '#worker/storage-buckets/service.ts'
import { ensureUserStorageBucketsTestSchema } from '#worker/storage-buckets/test-schema.ts'
import { createStableUserIdFromEmail } from '#worker/user-id.ts'
import {
	assertStorageRunnerWriteWithinEntitlement,
	createStorageKodyTools,
	createExecuteStorageId,
	emptyStorageRunnerEstimatedBytes,
	StorageRunner,
	storageRunnerRpc,
} from './storage-runner.ts'

async function ensureStorageRunnerTestSchema() {
	await ensureUserStorageBucketsTestSchema(env.APP_DB)
	clearStorageBucketRegistrationDedupeForTests()
}

async function ensureStorageBytesEmailTestSchema() {
	await ensureEntitlementTestSchema(env.APP_DB)
	await env.APP_DB.prepare(
		`CREATE TABLE IF NOT EXISTS email_messages (
	id TEXT PRIMARY KEY,
	direction TEXT NOT NULL,
	user_id TEXT NOT NULL,
	from_address TEXT NOT NULL DEFAULT '',
	envelope_from TEXT,
	to_addresses_json TEXT NOT NULL DEFAULT '[]',
	cc_addresses_json TEXT NOT NULL DEFAULT '[]',
	bcc_addresses_json TEXT NOT NULL DEFAULT '[]',
	reply_to_addresses_json TEXT NOT NULL DEFAULT '[]',
	subject TEXT NOT NULL DEFAULT '',
	message_id_header TEXT,
	in_reply_to_header TEXT,
	references_json TEXT NOT NULL DEFAULT '[]',
	headers_json TEXT NOT NULL DEFAULT '{}',
	auth_results TEXT,
	text_body TEXT,
	html_body TEXT,
	raw_mime_key TEXT,
	raw_size INTEGER NOT NULL DEFAULT 0,
	processing_status TEXT NOT NULL DEFAULT 'stored',
	provider_message_id TEXT,
	error TEXT,
	received_at TEXT,
	sent_at TEXT,
	created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
	updated_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
)`,
	).run()
}

async function seedPlannedStorageUser(input: {
	email: string
	plan: 'pro' | 'max'
	rawSize: number
}) {
	const userId = await createStableUserIdFromEmail(input.email)
	await env.APP_DB.prepare(
		`INSERT INTO users (
			username, email, password_hash, email_verified_at, plan,
			stable_user_id, d1_storage_bytes, d1_storage_bytes_updated_at
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
	)
		.bind(
			`storage-${crypto.randomUUID().slice(0, 8)}`,
			input.email,
			'test-password-hash',
			new Date().toISOString(),
			input.plan,
			userId,
			input.rawSize,
			new Date().toISOString(),
		)
		.run()
	await env.APP_DB.prepare(
		`INSERT INTO email_messages (
			id, direction, user_id, from_address, raw_size, processing_status,
			created_at, updated_at
		) VALUES (?, 'inbound', ?, 'sender@example.com', ?, 'stored', ?, ?)`,
	)
		.bind(
			`storage-quota-${crypto.randomUUID()}`,
			userId,
			input.rawSize,
			new Date().toISOString(),
			new Date().toISOString(),
		)
		.run()
	return userId
}

test('storage runner preserves isolated state per storage id', async () => {
	await ensureStorageRunnerTestSchema()
	const storageIdA = createExecuteStorageId()
	const storageIdB = createExecuteStorageId()
	const runnerA = storageRunnerRpc({
		env,
		userId: 'user-123',
		storageId: storageIdA,
	})
	const runnerB = storageRunnerRpc({
		env,
		userId: 'user-123',
		storageId: storageIdB,
	})

	await expect(
		runnerA.setValue({
			key: 'counter',
			value: 2,
		}),
	).resolves.toEqual({
		ok: true,
		key: 'counter',
	})
	await expect(
		runnerB.setValue({
			key: 'counter',
			value: 1,
		}),
	).resolves.toEqual({
		ok: true,
		key: 'counter',
	})

	await expect(
		runnerA.getValue({
			key: 'counter',
		}),
	).resolves.toEqual({
		key: 'counter',
		value: 2,
	})
	await expect(
		runnerB.getValue({
			key: 'counter',
		}),
	).resolves.toEqual({
		key: 'counter',
		value: 1,
	})

	await expect(
		runnerA.exportStorage({
			pageSize: 10,
		}),
	).resolves.toMatchObject({
		entries: [
			{
				key: 'counter',
				value: 2,
			},
		],
	})
	await expect(
		runnerB.exportStorage({
			pageSize: 10,
		}),
	).resolves.toMatchObject({
		entries: [
			{
				key: 'counter',
				value: 1,
			},
		],
	})
})

test('storage runner write tools enforce storage byte entitlements for planned users', async () => {
	await ensureStorageBytesEmailTestSchema()
	clearStorageBucketRegistrationDedupeForTests()
	const limit = planLimits.pro.maxStorageBytes
	if (limit === null) throw new Error('Expected a numeric pro storage cap.')
	const plannedEmail = `storage-planned-${crypto.randomUUID()}@example.com`
	const plannedUserId = await seedPlannedStorageUser({
		email: plannedEmail,
		plan: 'pro',
		rawSize: limit,
	})
	const plannedStorageId = createExecuteStorageId()
	const plannedTools = createStorageKodyTools({
		env,
		userId: plannedUserId,
		email: plannedEmail,
		storageId: plannedStorageId,
		writable: true,
	})

	const denied = await plannedTools
		.storage_set({
			key: 'new-key',
			value: 'new-value',
		})
		.then(
			() => null,
			(thrown: unknown) => thrown,
		)
	if (!(denied instanceof EntitlementLimitError)) {
		throw new Error('Expected an EntitlementLimitError.')
	}
	expect(denied.details).toMatchObject({
		resource: 'storage_bytes',
		plan: 'pro',
		limit,
	})
	expect(denied.details.current).toBeGreaterThanOrEqual(limit)
	await expect(
		storageRunnerRpc({
			env,
			userId: plannedUserId,
			storageId: plannedStorageId,
		}).getValue({ key: 'new-key' }),
	).resolves.toEqual({ key: 'new-key', value: null })

	const maxEmail = `storage-max-${crypto.randomUUID()}@example.com`
	const maxUserId = await seedPlannedStorageUser({
		email: maxEmail,
		plan: 'max',
		rawSize: limit,
	})
	const maxStorageId = createExecuteStorageId()
	const maxTools = createStorageKodyTools({
		env,
		userId: maxUserId,
		email: maxEmail,
		storageId: maxStorageId,
		writable: true,
	})
	await expect(
		maxTools.storage_set({
			key: 'new-key',
			value: 'new-value',
		}),
	).resolves.toEqual({ ok: true, key: 'new-key' })
})

test('storage runner storage byte entitlement aggregates only inventoried user buckets', async () => {
	await ensureStorageBytesEmailTestSchema()
	clearStorageBucketRegistrationDedupeForTests()
	const limit = planLimits.pro.maxStorageBytes
	const email = `storage-aggregate-${crypto.randomUUID()}@example.com`
	const userId = await seedPlannedStorageUser({
		email,
		plan: 'pro',
		rawSize: 0,
	})
	const storageIdA = createExecuteStorageId()
	const storageIdB = createExecuteStorageId()
	const runnerA = storageRunnerRpc({ env, userId, storageId: storageIdA })
	const runnerB = storageRunnerRpc({ env, userId, storageId: storageIdB })
	await runnerA.setValue({ key: 'first-bucket', value: 'stored bytes' })
	await runnerB.setValue({ key: 'second-bucket', value: 'stored bytes' })
	await flushStorageBucketRegistrationsForTests()
	await expect(listUserStorageBucketIds({ env, userId })).resolves.toEqual(
		[storageIdA, storageIdB].sort(),
	)

	const estimateA = (await runnerA.getEstimatedBytes()).estimatedBytes
	const estimateB = (await runnerB.getEstimatedBytes()).estimatedBytes
	expect(estimateA).toBeGreaterThan(0)
	expect(estimateB).toBeGreaterThan(0)
	const initialD1Bytes = await readUserD1StorageBytes({
		db: env.APP_DB,
		userId,
	})
	const targetD1Bytes = limit - estimateB - 1
	await env.APP_DB.prepare(
		`UPDATE users
		SET d1_storage_bytes = ?,
			d1_storage_bytes_updated_at = ?
		WHERE stable_user_id = ?`,
	)
		.bind(targetD1Bytes, new Date().toISOString(), userId)
		.run()
	expect(initialD1Bytes).toBe(0)
	// D1 remains the sole payload authority for composed getCurrent.
	await expect(
		readUserD1StorageBytes({ db: env.APP_DB, userId }),
	).resolves.toBe(targetD1Bytes)

	const aggregateDenied = await assertStorageRunnerWriteWithinEntitlement({
		env,
		userId,
		email,
		storageId: storageIdB,
		requested: 1,
	}).then(
		() => null,
		(thrown: unknown) => thrown,
	)
	if (!(aggregateDenied instanceof EntitlementLimitError)) {
		throw new Error(
			'Expected aggregate bucket usage to exceed the entitlement.',
		)
	}
	expect(aggregateDenied.details).toMatchObject({
		resource: 'storage_bytes',
		limit,
		current: targetD1Bytes + estimateA + estimateB,
	})

	// The first bucket still exists physically, but removing its ownership row
	// makes it ineligible for this user's aggregate. The remaining single bucket
	// is exactly at the allowed boundary and retains the previous behavior.
	await env.APP_DB.prepare(
		`DELETE FROM user_storage_buckets WHERE user_id = ? AND storage_id = ?`,
	)
		.bind(userId, storageIdA)
		.run()
	await expect(listUserStorageBucketIds({ env, userId })).resolves.toEqual([
		storageIdB,
	])
	await expect(
		assertStorageRunnerWriteWithinEntitlement({
			env,
			userId,
			email,
			storageId: storageIdB,
			requested: 1,
		}),
	).resolves.toBeUndefined()
	await expect(runnerA.getValue({ key: 'first-bucket' })).resolves.toEqual({
		key: 'first-bucket',
		value: 'stored bytes',
	})
})

test('storage runner supports raw SQL with explicit writable access', async () => {
	await ensureStorageRunnerTestSchema()
	const storageId = createExecuteStorageId()
	const runner = storageRunnerRpc({
		env,
		userId: 'user-123',
		storageId,
	})

	await expect(
		runner.sqlQuery({
			query:
				'create table if not exists counters (id integer primary key, value integer)',
			writable: true,
		}),
	).resolves.toMatchObject({
		rowsWritten: 2,
	})
	await expect(
		runner.sqlQuery({
			query: 'insert into counters (value) values (?)',
			params: [5],
			writable: true,
		}),
	).resolves.toMatchObject({
		rowsWritten: 1,
	})
	await expect(
		runner.sqlQuery({
			query: 'select value from counters order by id asc',
		}),
	).resolves.toEqual({
		columns: ['value'],
		rows: [{ value: 5 }],
		rowCount: 1,
		rowsRead: 1,
		rowsWritten: 0,
	})

	const stub = env.STORAGE_RUNNER.get(
		env.STORAGE_RUNNER.idFromName(JSON.stringify(['user-123', storageId])),
	)
	await runInDurableObject(stub, async (instance: StorageRunner, state) => {
		expect(instance).toBeInstanceOf(StorageRunner)
		expect(state.storage.sql.databaseSize).toBeGreaterThan(0)
	})
})

test('storage runner enforces read-only SQL policy for mutations, multi-statement queries, and literal semicolons', async () => {
	await ensureStorageRunnerTestSchema()
	const storageId = createExecuteStorageId()
	const runner = storageRunnerRpc({
		env,
		userId: 'user-123',
		storageId,
	})
	const readOnlyError =
		'Read-only storage.sql only allows a single SELECT, EXPLAIN, or schema PRAGMA statement. Pass writable: true to allow multi-statement or mutating queries.'
	// Rejections that cross the test RPC stub surface twice inside workerd and
	// print `uncaught exception` noise, so run the intentionally failing
	// queries inside the Durable Object instead.
	const failingStub = env.STORAGE_RUNNER.get(
		env.STORAGE_RUNNER.idFromName(JSON.stringify(['user-123', storageId])),
	)

	await runInDurableObject(failingStub, async (instance: StorageRunner) => {
		await expect(
			instance.sqlQuery({
				query: 'delete from counters',
				writable: false,
			}),
		).rejects.toThrow(readOnlyError)
	})

	await runner.setValue({
		key: 'counter',
		value: 1,
	})

	await runInDurableObject(failingStub, async (instance: StorageRunner) => {
		await expect(
			instance.sqlQuery({
				query: 'select 1 as ok; delete from sqlite_schema',
				writable: false,
			}),
		).rejects.toThrow(readOnlyError)
	})

	await expect(
		runner.getValue({
			key: 'counter',
		}),
	).resolves.toEqual({
		key: 'counter',
		value: 1,
	})

	await expect(
		runner.sqlQuery({
			query: "select 'a;b' as val",
			writable: false,
		}),
	).resolves.toEqual({
		columns: ['val'],
		rows: [{ val: 'a;b' }],
		rowCount: 1,
		rowsRead: 0,
		rowsWritten: 0,
	})
})

test('storage runner registers buckets on writes but not on reads', async () => {
	await ensureStorageRunnerTestSchema()
	const userId = `storage-register-${crypto.randomUUID()}`
	const writeStorageId = createExecuteStorageId()
	const readStorageId = createExecuteStorageId()
	const writer = storageRunnerRpc({
		env,
		userId,
		storageId: writeStorageId,
	})
	const reader = storageRunnerRpc({
		env,
		userId,
		storageId: readStorageId,
	})

	await reader.getValue({ key: 'missing' })
	await reader.listValues({ pageSize: 10 })
	await reader.exportStorage({ pageSize: 10 })
	await reader.sqlQuery({
		query: 'select 1 as ok',
		writable: false,
	})
	await flushStorageBucketRegistrationsForTests()
	await expect(listUserStorageBucketIds({ env, userId })).resolves.toEqual([])

	await writer.setValue({ key: 'counter', value: 1 })
	await flushStorageBucketRegistrationsForTests()
	await expect(listUserStorageBucketIds({ env, userId })).resolves.toEqual([
		writeStorageId,
	])

	// The mutating write also persists this bucket's byte estimate on its
	// inventory row so entitlement baselines can read it without a DO probe.
	const estimates = await listUserStorageBucketEstimates({ env, userId })
	expect(estimates).toHaveLength(1)
	expect(estimates[0]?.storageId).toBe(writeStorageId)
	expect(estimates[0]?.estimatedBytes).toBeGreaterThan(0)
})

test('getEstimatedBytes on a never-written bucket returns the empty DO baseline without registering', async () => {
	await ensureStorageRunnerTestSchema()
	const userId = `storage-empty-probe-${crypto.randomUUID()}`
	const storageId = crypto.randomUUID()
	const runner = storageRunnerRpc({ env, userId, storageId })
	const estimate = await runner.getEstimatedBytes()
	expect(estimate.estimatedBytes).toBe(emptyStorageRunnerEstimatedBytes)
	await flushStorageBucketRegistrationsForTests()
	await expect(listUserStorageBucketIds({ env, userId })).resolves.toEqual([])
})

test('storage runner dedupes bucket registration to one D1 write per isolate', async () => {
	await ensureStorageRunnerTestSchema()
	const userId = `storage-dedupe-${crypto.randomUUID()}`
	const storageId = createExecuteStorageId()
	let insertCount = 0
	const originalPrepare = env.APP_DB.prepare.bind(env.APP_DB)
	env.APP_DB.prepare = ((sql: string) => {
		if (sql.includes('INSERT INTO user_storage_buckets')) {
			insertCount += 1
		}
		return originalPrepare(sql)
	}) as typeof env.APP_DB.prepare

	try {
		const runner = storageRunnerRpc({
			env,
			userId,
			storageId,
		})
		await runner.setValue({ key: 'a', value: 1 })
		await runner.setValue({ key: 'b', value: 2 })
		await runner.deleteValue({ key: 'a' })
		await runner.sqlQuery({
			query: 'create table if not exists t (id integer primary key)',
			writable: true,
		})
		await flushStorageBucketRegistrationsForTests()
		expect(insertCount).toBe(1)
		await expect(listUserStorageBucketIds({ env, userId })).resolves.toEqual([
			storageId,
		])
	} finally {
		env.APP_DB.prepare = originalPrepare
	}
})

test('clearStorage during account-deletion purge must not recreate ownership rows', async () => {
	await ensureStorageRunnerTestSchema()
	const userId = `storage-delete-race-${crypto.randomUUID()}`
	const storageId = createExecuteStorageId()
	const runner = storageRunnerRpc({
		env,
		userId,
		storageId,
	})

	await runner.setValue({ key: 'keep-until-purge', value: 1 })
	await flushStorageBucketRegistrationsForTests()
	await expect(listUserStorageBucketIds({ env, userId })).resolves.toEqual([
		storageId,
	])

	// Account deletion often runs in a fresh isolate, so in-memory dedupe
	// cannot paper over a clearStorage registration race.
	clearStorageBucketRegistrationDedupeForTests()

	// Hold any ownership upsert until after the D1 delete so a fire-and-forget
	// clearStorage registration cannot win the race before the assertion.
	let releaseInsert: (() => void) | null = null
	const insertGate = new Promise<void>((resolve) => {
		releaseInsert = resolve
	})
	const originalPrepare = env.APP_DB.prepare.bind(env.APP_DB)
	env.APP_DB.prepare = ((sql: string) => {
		const statement = originalPrepare(sql)
		if (!sql.includes('INSERT INTO user_storage_buckets')) {
			return statement
		}
		return {
			bind(...params: Array<unknown>) {
				const bound = statement.bind(...params)
				return {
					async run() {
						await insertGate
						return await bound.run()
					},
				}
			},
		}
	}) as typeof env.APP_DB.prepare

	try {
		await runner.clearStorage()
		await env.APP_DB.prepare(
			`DELETE FROM user_storage_buckets WHERE user_id = ?`,
		)
			.bind(userId)
			.run()
		releaseInsert?.()
		await flushStorageBucketRegistrationsForTests()
		await expect(listUserStorageBucketIds({ env, userId })).resolves.toEqual([])
	} finally {
		env.APP_DB.prepare = originalPrepare
		releaseInsert?.()
	}
})
