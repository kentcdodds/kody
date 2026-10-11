import { env } from 'cloudflare:workers'
import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { expect, test } from 'vitest'
import { ensureUserStorageBucketsTestSchema } from '#worker/storage-buckets/test-schema.ts'
import { clearStorageBucketRegistrationDedupeForTests } from '#worker/storage-buckets/service.ts'
import { storageRunnerRpc } from '#worker/storage-runner.ts'
import { clearOwnerStorage, copyOwnerStorage } from './storage-copy.ts'

async function seedSource() {
	await ensureUserStorageBucketsTestSchema(env.APP_DB)
	clearStorageBucketRegistrationDedupeForTests()
	const fromUserId = ownerIdFromStored(`org-from-${crypto.randomUUID()}`)
	const toUserId = ownerIdFromStored(`org-to-${crypto.randomUUID()}`)
	const storageId = `package:${crypto.randomUUID()}`
	const source = storageRunnerRpc({ env, userId: fromUserId, storageId })
	for (let index = 0; index < 205; index += 1) {
		await source.setValue({ key: `key-${index}`, value: { index } })
	}
	await source.sqlQuery({
		query:
			'create table notes (id integer primary key, body text not null, updated integer not null default 0)',
		writable: true,
	})
	await source.sqlQuery({
		query: 'create index notes_body on notes (body)',
		writable: true,
	})
	await source.sqlQuery({
		query:
			'create trigger notes_touch after insert on notes begin update notes set updated = updated + 1 where id = new.id; end',
		writable: true,
	})
	for (let index = 0; index < 3; index += 1) {
		await source.sqlQuery({
			query: 'insert into notes (body) values (?)',
			params: [`note ${index}`],
			writable: true,
		})
	}
	return { fromUserId, toUserId, storageId }
}

test('copyOwnerStorage copies KV pages and SQL tables and verifies counts', async () => {
	const { fromUserId, toUserId, storageId } = await seedSource()
	const result = await copyOwnerStorage({
		env,
		fromUserId,
		toUserId,
		storageId,
	})
	expect(result).toEqual({
		storageId,
		kvEntries: 205,
		sqlRows: { notes: 3 },
	})
	const target = storageRunnerRpc({ env, userId: toUserId, storageId })
	await expect(target.getValue({ key: 'key-204' })).resolves.toEqual({
		key: 'key-204',
		value: { index: 204 },
	})
	// Rows copy as stored: the trigger is replayed after the rows, so it did
	// not fire again during the copy.
	await expect(
		target.sqlQuery({ query: 'select body, updated from notes order by id' }),
	).resolves.toMatchObject({
		rows: [
			{ body: 'note 0', updated: 1 },
			{ body: 'note 1', updated: 1 },
			{ body: 'note 2', updated: 1 },
		],
	})
	await target.sqlQuery({
		query: 'insert into notes (body) values (?)',
		params: ['after copy'],
		writable: true,
	})
	await expect(
		target.sqlQuery({
			query: `select updated from notes where body = 'after copy'`,
		}),
	).resolves.toMatchObject({ rows: [{ updated: 1 }] })
})

test('copyOwnerStorage refuses a target that already holds data', async () => {
	const { fromUserId, toUserId, storageId } = await seedSource()
	await storageRunnerRpc({ env, userId: toUserId, storageId }).setValue({
		key: 'existing',
		value: true,
	})
	await expect(
		copyOwnerStorage({ env, fromUserId, toUserId, storageId }),
	).rejects.toThrow(`Target storage ${storageId} is not empty.`)
})

test('clearOwnerStorage empties the copy so a retry can start over', async () => {
	const { fromUserId, toUserId, storageId } = await seedSource()
	await copyOwnerStorage({ env, fromUserId, toUserId, storageId })
	await clearOwnerStorage({ env, userId: toUserId, storageId })
	await expect(
		copyOwnerStorage({ env, fromUserId, toUserId, storageId }),
	).resolves.toMatchObject({ kvEntries: 205 })
})
