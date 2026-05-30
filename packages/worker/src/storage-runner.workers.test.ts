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

	try {
		await runner.sqlQuery({
			query: 'delete from counters',
			writable: false,
		})
		throw new Error('Expected read-only SQL mutation to fail.')
	} catch (error) {
		expect(error).toBeInstanceOf(Error)
		expect((error as Error).message).toBe(readOnlyError)
	}

	await runner.setValue({
		key: 'counter',
		value: 1,
	})

	try {
		await runner.sqlQuery({
			query: 'select 1 as ok; delete from sqlite_schema',
			writable: false,
		})
		throw new Error('Expected multi-statement read-only SQL to fail.')
	} catch (error) {
		expect(error).toBeInstanceOf(Error)
		expect((error as Error).message).toBe(readOnlyError)
	}

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
