import { expect, test } from 'vitest'
import { repoSessionIdSchema } from './repo-shared.ts'

test('repoSessionIdSchema accepts real session ids and rejects placeholders', () => {
	expect(
		repoSessionIdSchema.parse({
			session_id: 'de72ddd6-e277-4f69-a5db-3d6ece06ca6b',
		}),
	).toEqual({
		session_id: 'de72ddd6-e277-4f69-a5db-3d6ece06ca6b',
	})
	expect(repoSessionIdSchema.parse({ session_id: 'session-1' })).toEqual({
		session_id: 'session-1',
	})
	for (const session_id of ['none', 'None', 'null', 'undefined', 'n/a']) {
		expect(repoSessionIdSchema.safeParse({ session_id }).success).toBe(false)
	}
})
