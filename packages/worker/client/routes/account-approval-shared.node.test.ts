import { expect, test } from 'vitest'
import { buildHostApprovalRequestUrl } from './account-approval-shared.ts'

test('buildHostApprovalRequestUrl maps secret approval links and rejects invalid input', () => {
	expect(
		buildHostApprovalRequestUrl(
			'https://example.com/account/secrets/user/slackAccessToken?allowed-host=slack.com',
			'https://example.com',
		),
	).toBe(
		'/account/secrets.json?allowed-host=slack.com&selected=user%3A%3A%3A%3AslackAccessToken',
	)
	expect(
		buildHostApprovalRequestUrl(
			'/account/secrets/user/githubAccessToken?allowed-host=api.github.com',
		),
	).toBe(
		'/account/secrets.json?allowed-host=api.github.com&selected=user%3A%3A%3A%3AgithubAccessToken',
	)
	expect(() =>
		buildHostApprovalRequestUrl('/account/secrets?allowed-host=slack.com'),
	).toThrow('Invalid approval link.')
})
