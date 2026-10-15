import { DatabaseSync } from 'node:sqlite'
import { expect, test } from 'vitest'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { consumeFollowCreateSlot, FollowRateLimitError } from './service.ts'
import { followCreateMaxPerHour } from './types.ts'

test('the 31st new follow in an hour is rejected', async () => {
	const db = createD1FromSqlite(new DatabaseSync(':memory:'))
	for (let index = 0; index < followCreateMaxPerHour; index += 1) {
		await consumeFollowCreateSlot(db, 'org-1')
	}
	await expect(consumeFollowCreateSlot(db, 'org-1')).rejects.toBeInstanceOf(
		FollowRateLimitError,
	)
	await expect(consumeFollowCreateSlot(db, 'org-2')).resolves.toBeUndefined()
})
