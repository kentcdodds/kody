import { expect, test } from 'vitest'
import {
	capabilityInputSecretAuthRequiredMessage,
	createCapabilitySecretAccessDeniedMessage,
	createCapabilitySecretAccessDeniedBatchMessage,
	createHostSecretAccessDeniedBatchMessage,
	createMissingSecretMessage,
	fetchSecretAuthRequiredMessage,
	isSecretAuthRequiredMessage,
	parseCapabilityAccessRequiredBatchMessage,
	parseCapabilityAccessRequiredMessage,
	parseHostApprovalRequiredBatchMessage,
	parseHostApprovalRequiredMessage,
	parseMissingSecretMessage,
} from './errors.ts'

test('secret error message helpers parse auth, missing-secret, and approval payloads', () => {
	expect(isSecretAuthRequiredMessage(fetchSecretAuthRequiredMessage)).toBe(true)
	expect(
		isSecretAuthRequiredMessage(capabilityInputSecretAuthRequiredMessage),
	).toBe(true)
	expect(
		parseMissingSecretMessage(createMissingSecretMessage('lutronPassword')),
	).toEqual({
		secretName: 'lutronPassword',
	})

	expect(
		parseHostApprovalRequiredMessage(
			'Secret "cloudflareToken" is not allowed for host "api.cloudflare.com". Retry after approval.',
		),
	).toEqual({
		secretName: 'cloudflareToken',
		host: 'api.cloudflare.com',
	})

	const capabilityMessage = createCapabilitySecretAccessDeniedMessage(
		'cloudflareToken',
		'secret_set',
		'https://example.com/account/secrets/user/cloudflareToken?capability=secret_set',
	)
	expect(parseCapabilityAccessRequiredMessage(capabilityMessage)).toEqual({
		secretName: 'cloudflareToken',
		capabilityName: 'secret_set',
	})

	const capabilityEntries = [
		{
			secretName: 'lutronUsername',
			capabilityName: 'lighting_lutron_set_credentials',
			approvalUrl:
				'https://example.com/account/secrets/user/lutronUsername?capability=lighting_lutron_set_credentials',
		},
		{
			secretName: 'lutronPassword',
			capabilityName: 'lighting_lutron_set_credentials',
			approvalUrl:
				'https://example.com/account/secrets/user/lutronPassword?capability=lighting_lutron_set_credentials',
		},
	]
	expect(
		parseCapabilityAccessRequiredBatchMessage(
			createCapabilitySecretAccessDeniedBatchMessage(capabilityEntries),
		),
	).toEqual(capabilityEntries)

	const hostEntries = [
		{
			secretName: 'cloudflareToken',
			host: 'api.cloudflare.com',
			approvalUrl:
				'https://example.com/account/secrets/user/cloudflareToken?allowed-host=api.cloudflare.com',
		},
		{
			secretName: 'githubToken',
			host: 'api.github.com',
			approvalUrl:
				'https://example.com/account/secrets/user/githubToken?allowed-host=api.github.com',
		},
	]
	expect(
		parseHostApprovalRequiredBatchMessage(
			createHostSecretAccessDeniedBatchMessage(hostEntries),
		),
	).toEqual(hostEntries)
})
