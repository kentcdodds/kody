import { env } from 'cloudflare:workers'
import { runInDurableObject } from 'cloudflare:test'
import { expect, test } from 'vitest'
import {
	createExecuteStorageId,
	StorageRunner,
	storageRunnerRpc,
} from './storage-runner.ts'

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

	const stub = env.STORAGE_RUNNER.get(env.STORAGE_RUNNER.idFromName(`user-123:${storageId}`))
	await runInDurableObject(stub, async (instance: StorageRunner, state) => {
		expect(instance).toBeInstanceOf(StorageRunner)
		expect(state.storage.sql.databaseSize).toBeGreaterThan(0)
	})
})

test('storage runner blocks mutating SQL when writable is false', async () => {
	const storageId = createExecuteStorageId()
	const runner = storageRunnerRpc({
		env,
		userId: 'user-123',
		storageId,
	})

	try {
		await runner.sqlQuery({
			query: 'delete from counters',
			writable: false,
		})
		throw new Error('Expected read-only SQL mutation to fail.')
	} catch (error) {
		expect(error).toBeInstanceOf(Error)
		expect((error as Error).message).toBe(
			'Read-only storage.sql only allows SELECT, EXPLAIN, and schema PRAGMA queries. Pass writable: true to allow mutations.',
		)
	}
})
