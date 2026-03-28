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

test('isSecretAuthRequiredMessage recognizes shared auth-required messages', () => {
	expect(isSecretAuthRequiredMessage(fetchSecretAuthRequiredMessage)).toBe(true)
	expect(
		isSecretAuthRequiredMessage(capabilityInputSecretAuthRequiredMessage),
	).toBe(true)
	expect(isSecretAuthRequiredMessage('Something else entirely.')).toBe(false)
})

test('parseMissingSecretMessage recognizes shared missing-secret messages', () => {
	const message = createMissingSecretMessage('lutronPassword')
	expect(parseMissingSecretMessage(message)).toEqual({
		secretName: 'lutronPassword',
	})
	expect(parseMissingSecretMessage('Secret missing')).toBeNull()
})

test('parseHostApprovalRequiredMessage extracts secret name and host', () => {
	expect(
		parseHostApprovalRequiredMessage(
			'Secret "cloudflareToken" is not allowed for host "api.cloudflare.com". If this request is expected, ask the user whether this host should be added to the secret\'s allowed hosts: https://example.com/account/secrets/approve',
		),
	).toEqual({
		secretName: 'cloudflareToken',
		host: 'api.cloudflare.com',
	})
	expect(parseHostApprovalRequiredMessage('Host approval failed')).toBeNull()
})

test('parseHostApprovalRequiredBatchMessage returns approval entries', () => {
	const entries = [
		{
			secretName: 'cloudflareToken',
			host: 'api.cloudflare.com',
			approvalUrl:
				'https://example.com/account/secrets/user/cloudflareToken?allowed-host=api.cloudflare.com&request=token',
		},
		{
			secretName: 'slackToken',
			host: 'slack.com',
			approvalUrl:
				'https://example.com/account/secrets/user/slackToken?allowed-host=slack.com&request=token',
		},
	]
	const message = createHostSecretAccessDeniedBatchMessage(entries)
	expect(parseHostApprovalRequiredBatchMessage(message)).toEqual(entries)
	expect(
		parseHostApprovalRequiredBatchMessage('Host approval failed'),
	).toBeNull()
})

test('parseCapabilitySecretAccessDeniedMessage extracts secret and capability', () => {
	const message = createCapabilitySecretAccessDeniedMessage(
		'cloudflareToken',
		'cloudflare_rest',
		'https://example.com/account/secrets/user/cloudflareToken?capability=cloudflare_rest',
	)
	expect(parseCapabilityAccessRequiredMessage(message)).toEqual({
		secretName: 'cloudflareToken',
		capabilityName: 'cloudflare_rest',
	})
	expect(
		parseCapabilityAccessRequiredMessage('Capability approval failed'),
	).toBeNull()
})

test('parseCapabilityAccessRequiredBatchMessage returns approval entries', () => {
	const entries = [
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
	const message = createCapabilitySecretAccessDeniedBatchMessage(entries)
	expect(parseCapabilityAccessRequiredBatchMessage(message)).toEqual(entries)
	expect(
		parseCapabilityAccessRequiredBatchMessage(
			createCapabilitySecretAccessDeniedBatchMessage([]),
		),
	).toBeNull()
	expect(
		parseCapabilityAccessRequiredBatchMessage('Capability approval failed'),
	).toBeNull()
})

test('parseHostApprovalRequiredBatchMessage returns approval entries', () => {
	const entries = [
		{
			secretName: 'cloudflareToken',
			host: 'api.cloudflare.com',
			approvalUrl:
				'https://example.com/account/secrets/user/cloudflareToken?allowed-host=api.cloudflare.com&request=token',
		},
		{
			secretName: 'githubToken',
			host: 'api.github.com',
			approvalUrl:
				'https://example.com/account/secrets/user/githubToken?allowed-host=api.github.com&request=token',
		},
	]
	const message = createHostSecretAccessDeniedBatchMessage(entries)
	expect(parseHostApprovalRequiredBatchMessage(message)).toEqual(entries)
	expect(
		parseHostApprovalRequiredBatchMessage(
			createHostSecretAccessDeniedBatchMessage([]),
		),
	).toBeNull()
	expect(
		parseHostApprovalRequiredBatchMessage('Host approval failed'),
	).toBeNull()
})
