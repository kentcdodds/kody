import { expect, test } from 'vitest'
import {
	buildRepoSearchInvalidRegexCallerMessage,
	isRepoSearchInvalidRegexMessage,
	isRepoSessionInactiveMessage,
	repoSearchInvalidRegexMessagePrefix,
	repoSessionInactiveMessagePhrase,
} from './repo-session-caller-error.ts'

test('isRepoSessionInactiveMessage matches published and other inactive statuses', () => {
	expect(
		isRepoSessionInactiveMessage(
			`Repo session "de72ddd6-e277-4f69-a5db-3d6ece06ca6b" is published${repoSessionInactiveMessagePhrase}`,
		),
	).toBe(true)
	expect(
		isRepoSessionInactiveMessage(
			`Repo session "abc" is discarded${repoSessionInactiveMessagePhrase}`,
		),
	).toBe(true)
	expect(
		isRepoSessionInactiveMessage('Repo session "abc" was not found.'),
	).toBe(false)
	expect(
		isRepoSessionInactiveMessage(
			`Something else${repoSessionInactiveMessagePhrase}`,
		),
	).toBe(false)
})

test('invalid regex helper keeps stable prefix and JS RegExp guidance', () => {
	const message = buildRepoSearchInvalidRegexCallerMessage(
		'Invalid regular expression: /(?s).|^$/gi: Invalid group',
	)
	expect(message.startsWith(repoSearchInvalidRegexMessagePrefix)).toBe(true)
	expect(isRepoSearchInvalidRegexMessage(message)).toBe(true)
	expect(message).toContain('JavaScript RegExp')
	expect(message).toContain('(?s)')
	expect(
		isRepoSearchInvalidRegexMessage(
			'repo_search requires a non-empty pattern.',
		),
	).toBe(false)
})
