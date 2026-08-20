import { expect, test } from 'vitest'
import {
	isGitPushNotFastForwardError,
	isGitPushNotFastForwardMessage,
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
