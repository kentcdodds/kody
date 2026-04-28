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

test('shared secret message helpers recognize auth and missing-secret cases', () => {
	expect(isSecretAuthRequiredMessage(fetchSecretAuthRequiredMessage)).toBe(true)
	expect(
		isSecretAuthRequiredMessage(capabilityInputSecretAuthRequiredMessage),
	).toBe(true)
	expect(isSecretAuthRequiredMessage('Something else entirely.')).toBe(false)
	expect(
		parseMissingSecretMessage(createMissingSecretMessage('lutronPassword')),
	).toEqual({
		secretName: 'lutronPassword',
	})
	expect(parseMissingSecretMessage('Secret missing')).toBeNull()
})

test('approval message parsers extract host and capability metadata', () => {
	expect(
		parseHostApprovalRequiredMessage(
			'Secret "cloudflareToken" is not allowed for host "api.cloudflare.com". Retry after approval.',
		),
	).toEqual({
		secretName: 'cloudflareToken',
		host: 'api.cloudflare.com',
	})
	expect(parseHostApprovalRequiredMessage('Host approval failed')).toBeNull()

	const message = createCapabilitySecretAccessDeniedMessage(
		'cloudflareToken',
		'secret_set',
		'https://example.com/account/secrets/user/cloudflareToken?capability=secret_set',
	)
	expect(parseCapabilityAccessRequiredMessage(message)).toEqual({
		secretName: 'cloudflareToken',
		capabilityName: 'secret_set',
	})
	expect(
		parseCapabilityAccessRequiredMessage('Capability approval failed'),
	).toBeNull()
})

test('batch approval parsers round-trip entries and reject invalid payloads', () => {
	const capabilityEntries = [
		{
			secretName: 'lutronUsername',
			capabilityName: 'home_lutron_set_credentials',
			approvalUrl:
				'https://example.com/account/secrets/user/lutronUsername?capability=home_lutron_set_credentials',
		},
		{
			secretName: 'lutronPassword',
			capabilityName: 'home_lutron_set_credentials',
			approvalUrl:
				'https://example.com/account/secrets/user/lutronPassword?capability=home_lutron_set_credentials',
		},
	]
	expect(
		parseCapabilityAccessRequiredBatchMessage(
			createCapabilitySecretAccessDeniedBatchMessage(capabilityEntries),
		),
	).toEqual(capabilityEntries)
	expect(
		parseCapabilityAccessRequiredBatchMessage(
			createCapabilitySecretAccessDeniedBatchMessage([]),
		),
	).toBeNull()
	expect(
		parseCapabilityAccessRequiredBatchMessage('Capability approval failed'),
	).toBeNull()
	expect(
		parseCapabilityAccessRequiredBatchMessage(
			'Secrets require capability approval: {"not":"an array"}',
		),
	).toBeNull()

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
	expect(
		parseHostApprovalRequiredBatchMessage(
			createHostSecretAccessDeniedBatchMessage([]),
		),
	).toBeNull()
	expect(
		parseHostApprovalRequiredBatchMessage('Host approval failed'),
	).toBeNull()
	expect(
		parseHostApprovalRequiredBatchMessage(
			'Secrets require host approval: {"not":"an array"}',
		),
	).toBeNull()
})
