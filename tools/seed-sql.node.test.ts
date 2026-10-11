import { expect, test } from 'vitest'
import { buildSeedUserSql } from './seed-sql.ts'

test('buildSeedUserSql rejects a username signup would not accept', () => {
	const seed = (username: string) =>
		buildSeedUserSql({
			email: 'seed@example.com',
			username,
			passwordHash: 'hash',
		})
	expect(seed('org-sections-1791688467100')).toContain(
		"'org-sections-1791688467100'",
	)
	expect(() => seed('org-switch-sections-1791688467100')).toThrow(
		'Seed username "org-switch-sections-1791688467100" is not a valid username',
	)
	expect(() => seed('Has_Underscore')).toThrow('is not a valid username')
})
