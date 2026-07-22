import { env } from 'cloudflare:workers'
import { runInDurableObject } from 'cloudflare:test'
import { expect, test } from 'vitest'
import { EntitlementLimitError } from '#worker/entitlements/errors.ts'
import { planLimits } from '#worker/entitlements/plans.ts'
import { ensureEntitlementTestSchema } from '#worker/entitlements/test-schema.ts'
import { createStableUserIdFromEmail } from '#worker/user-id.ts'
import {
	createStorageKodyTools,
	createExecuteStorageId,
	StorageRunner,
	storageRunnerRpc,
} from './storage-runner.ts'

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
	plan: 'pro' | null
	rawSize: number
}) {
	const userId = await createStableUserIdFromEmail(input.email)
	await env.APP_DB.prepare(
		`INSERT INTO users (username, email, password_hash, email_verified_at, plan, stable_user_id)
		VALUES (?, ?, ?, ?, ?, ?)`,
	)
		.bind(
			`storage-${crypto.randomUUID().slice(0, 8)}`,
			input.email,
			'test-password-hash',
			new Date().toISOString(),
			input.plan,
			userId,
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

	const noPlanEmail = `storage-unplanned-${crypto.randomUUID()}@example.com`
	const noPlanUserId = await seedPlannedStorageUser({
		email: noPlanEmail,
		plan: null,
		rawSize: limit,
	})
	const noPlanStorageId = createExecuteStorageId()
	const noPlanTools = createStorageKodyTools({
		env,
		userId: noPlanUserId,
		email: noPlanEmail,
		storageId: noPlanStorageId,
		writable: true,
	})
	await expect(
		noPlanTools.storage_set({
			key: 'new-key',
			value: 'new-value',
		}),
	).resolves.toEqual({ ok: true, key: 'new-key' })
})

test('storage runner supports raw SQL with explicit writable access', async () => {
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
