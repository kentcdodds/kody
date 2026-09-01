import { expect, test } from 'vitest'
import {
	isGitPushNotFastForwardError,
	isGitPushNotFastForwardMessage,
	isRepoSessionInactiveMessage,
	isRepoSessionNotFoundMessage,
} from './repo-session-caller-error.ts'

test('isGitPushNotFastForwardError matches isomorphic-git PushRejected non-FF only', () => {
	expect(
		isGitPushNotFastForwardMessage(
			'Push rejected because it was not a simple fast-forward. Use "force: true" to override.',
		),
	).toBe(true)
	expect(
		isGitPushNotFastForwardMessage('Push rejected because tag-exists'),
	).toBe(false)

	const nonFastForward = Object.assign(
		new Error(
			'Push rejected because it was not a simple fast-forward. Use "force: true" to override.',
		),
		{ name: 'PushRejectedError', code: 'PushRejectedError' },
	)
	expect(isGitPushNotFastForwardError(nonFastForward)).toBe(true)

	const tagExists = Object.assign(
		new Error('Push rejected because tag-exists'),
		{ name: 'PushRejectedError', code: 'PushRejectedError' },
	)
	expect(isGitPushNotFastForwardError(tagExists)).toBe(false)

	expect(isGitPushNotFastForwardError(new Error('D1 write failed.'))).toBe(
		false,
	)
})

test('isRepoSessionNotFoundMessage matches missing and wrong-user phrases only', () => {
	expect(
		isRepoSessionNotFoundMessage('Repo session "none" was not found.'),
	).toBe(true)
	expect(
		isRepoSessionNotFoundMessage(
			'Repo session "none" was not found. Use repoListSessions or repoOpenSession to obtain a valid session_id.',
		),
	).toBe(true)
	expect(
		isRepoSessionNotFoundMessage(
			'Repo session "de72ddd6-e277-4f69-a5db-3d6ece06ca6b" was not found for this user.',
		),
	).toBe(true)
	expect(
		isRepoSessionNotFoundMessage(
			'Repo session "de72ddd6-e277-4f69-a5db-3d6ece06ca6b" is published; open a new session before continuing.',
		),
	).toBe(false)
	expect(isRepoSessionNotFoundMessage('Source "abc" was not found.')).toBe(
		false,
	)
	expect(
		isRepoSessionInactiveMessage(
			'Repo session "de72ddd6-e277-4f69-a5db-3d6ece06ca6b" is published; open a new session before continuing.',
		),
	).toBe(true)
})
