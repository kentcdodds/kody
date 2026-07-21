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
	expect(
		buildHostApprovalRequestUrl(
			'https://example.com/account/secrets/user/cloudflareToken?capability=secret_set',
			'https://example.com',
		),
	).toBe(
		'/account/secrets.json?capability=secret_set&selected=user%3A%3A%3A%3AcloudflareToken',
	)
	expect(
		buildHostApprovalRequestUrl(
			'/account/secrets/package/pkg-1/signingSecret?capability=secret_jwt_sign',
		),
	).toBe(
		'/account/secrets.json?capability=secret_jwt_sign&selected=package%3A%3Apkg-1%3A%3AsigningSecret',
	)
	expect(() =>
		buildHostApprovalRequestUrl('/account/secrets?allowed-host=slack.com'),
	).toThrow('Invalid approval link.')
})
