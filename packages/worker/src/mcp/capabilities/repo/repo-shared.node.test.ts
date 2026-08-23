import { expect, test } from 'vitest'
import { repoSessionIdSchema } from './repo-shared.ts'

test('repoSessionIdSchema accepts real session ids', () => {
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
})

test('repoSessionIdSchema rejects placeholder session ids', () => {
	for (const session_id of ['none', 'None', 'null', 'undefined', 'n/a']) {
		const result = repoSessionIdSchema.safeParse({ session_id })
		expect(result.success).toBe(false)
		if (result.success) continue
		expect(result.error.issues[0]?.message).toContain(
			'not a placeholder like "none"',
		)
	}
})
