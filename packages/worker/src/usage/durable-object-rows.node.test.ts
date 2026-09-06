import { expect, test, vi } from 'vitest'
import { recordUsage } from './record-usage.ts'
import { recordDurableObjectRowsRead } from './durable-object-rows.ts'

vi.mock('./record-usage.ts', () => ({
	recordUsage: vi.fn(async () => undefined),
}))

test('recordDurableObjectRowsRead writes the truncated row count', async () => {
	await recordDurableObjectRowsRead({
		env: {},
		userId: 'user-1',
		doClass: 'StorageRunner',
		rowsRead: 12.9,
	})
	expect(vi.mocked(recordUsage)).toHaveBeenCalledWith(
		{},
		{
			userId: 'user-1',
			eventType: 'durable_object_rows_read',
			entityId: 'StorageRunner',
			eventCount: 12,
			outcome: 'success',
		},
	)
})

test('recordDurableObjectRowsRead skips empty user ids and zero-row queries', async () => {
	await recordDurableObjectRowsRead({
		env: {},
		userId: '',
		doClass: 'StorageRunner',
		rowsRead: 9,
	})
	await recordDurableObjectRowsRead({
		env: {},
		userId: 'user-1',
		doClass: 'StorageRunner',
		rowsRead: 0,
	})
	expect(vi.mocked(recordUsage)).not.toHaveBeenCalled()
})
