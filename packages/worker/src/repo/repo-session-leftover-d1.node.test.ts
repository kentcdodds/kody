import { expect, test } from 'vitest'
import { isMissingRepoSessionsTable } from './repo-session-leftover-d1.ts'

test('missing leftover table matcher accepts qualified D1 names', () => {
	expect(
		isMissingRepoSessionsTable(new Error('no such table: repo_sessions')),
	).toBe(true)
	expect(
		isMissingRepoSessionsTable(
			new Error('D1_ERROR: no such table: main.repo_sessions'),
		),
	).toBe(true)
	expect(
		isMissingRepoSessionsTable(new Error('no such table: "repo_sessions"')),
	).toBe(true)
	expect(isMissingRepoSessionsTable(new Error('no such table: users'))).toBe(
		false,
	)
	expect(
		isMissingRepoSessionsTable(
			new Error('no such table: repo_sessions_backup'),
		),
	).toBe(false)
	expect(
		isMissingRepoSessionsTable(
			new Error('D1_ERROR: no such table: main.repo_sessions_backup'),
		),
	).toBe(false)
})
