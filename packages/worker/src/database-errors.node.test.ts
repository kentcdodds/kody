import { expect, test } from 'vitest'
import { getUniqueConstraintField } from './database-errors.ts'

test('getUniqueConstraintField reads table columns, named unique indexes, and wrapped causes', () => {
	expect(
		getUniqueConstraintField(
			new Error('UNIQUE constraint failed: users.email'),
		),
	).toBe('email')
	expect(
		getUniqueConstraintField(
			new Error('UNIQUE constraint failed: users.stable_user_id'),
		),
	).toBe('stable_user_id')
	expect(
		getUniqueConstraintField(
			new Error('UNIQUE constraint failed: idx_users_stable_user_id'),
		),
	).toBe('stable_user_id')
	expect(
		getUniqueConstraintField(
			new Error(
				'D1_ERROR: UNIQUE constraint failed: idx_users_stable_user_id: SQLITE_CONSTRAINT',
			),
		),
	).toBe('stable_user_id')

	const wrapped = new Error('D1_ERROR')
	wrapped.cause = new Error(
		'UNIQUE constraint failed: idx_users_stable_user_id',
	)
	expect(getUniqueConstraintField(wrapped)).toBe('stable_user_id')
})
