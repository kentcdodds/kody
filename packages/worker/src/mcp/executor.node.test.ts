import { expect, test } from 'vitest'
import {
	createCapabilitySecretAccessDeniedBatchMessage,
	createCapabilitySecretAccessDeniedMessage,
	createHostSecretAccessDeniedBatchMessage,
	createMissingSecretMessage,
} from '#mcp/secrets/errors.ts'
import { formatExecutionOutput, getExecutionErrorDetails } from './executor.ts'

test('getExecutionErrorDetails returns concrete guidance for capability access denial', () => {
	const error = new Error(
		createCapabilitySecretAccessDeniedMessage(
			'cloudflareToken',
			'secret_set',
			'https://example.com/account/secrets/user/cloudflareToken?capability=secret_set',
		),
	)

	expect(getExecutionErrorDetails(error)).toEqual({
		kind: 'secret_capability_access_required',
		message:
			'Secret "cloudflareToken" is not allowed for capability "secret_set". If this capability should be able to use the secret, ask the user whether to add "secret_set" to the secret\'s allowed capabilities in the account secrets UI, then retry after they approve that policy change. Approval link: https://example.com/account/secrets/user/cloudflareToken?capability=secret_set',
		nextStep:
			"Ask the user whether this capability should be allowed to use the secret. If they approve, help them add this capability name to the secret's allowed capabilities in the account secrets UI, then retry.",
		secretNames: ['cloudflareToken'],
		capabilityName: 'secret_set',
		approvalUrl:
			'https://example.com/account/secrets/user/cloudflareToken?capability=secret_set',
		suggestedAction: {
			type: 'edit_secret_policy',
			policyField: 'allowed_capabilities',
		},
	})
})

test('formatExecutionOutput includes capability access next step', () => {
	const result = {
		error: new Error(
			createCapabilitySecretAccessDeniedMessage(
				'cloudflareToken',
				'secret_set',
				'https://example.com/account/secrets/user/cloudflareToken?capability=secret_set',
			),
		),
	} as const

	expect(formatExecutionOutput(result)).toContain(
		"Next step: Ask the user whether this capability should be allowed to use the secret. If they approve, help them add this capability name to the secret's allowed capabilities in the account secrets UI, then retry.",
	)
})

test('formatExecutionOutput keeps missing secret guidance intact', () => {
	const result = {
		error: new Error(createMissingSecretMessage('missingToken')),
	} as const

	expect(formatExecutionOutput(result)).toContain(
		'Open a generated UI so the user can provide and save this secret',
	)
})

test('getExecutionErrorDetails returns batch capability approvals', () => {
	const error = new Error(
		createCapabilitySecretAccessDeniedBatchMessage([
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
		]),
	)

	expect(getExecutionErrorDetails(error)).toEqual({
		kind: 'secret_capability_access_required_batch',
		message:
			'Secrets require capability approval: [{"secretName":"lutronUsername","capabilityName":"home_lutron_set_credentials","approvalUrl":"https://example.com/account/secrets/user/lutronUsername?capability=home_lutron_set_credentials"},{"secretName":"lutronPassword","capabilityName":"home_lutron_set_credentials","approvalUrl":"https://example.com/account/secrets/user/lutronPassword?capability=home_lutron_set_credentials"}]',
		nextStep:
			'Ask the user whether they want to approve these capabilities for the listed secrets in the account secrets UI, then retry after approval.',
		missingApprovals: [
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
		],
		suggestedAction: {
			type: 'edit_secret_policy',
			policyField: 'allowed_capabilities',
		},
	})
})

test('getExecutionErrorDetails returns batch host approvals', () => {
	const error = new Error(
		createHostSecretAccessDeniedBatchMessage([
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
		]),
	)

	expect(getExecutionErrorDetails(error)).toEqual({
		kind: 'host_approval_required_batch',
		message:
			'Secrets require host approval: [{"secretName":"cloudflareToken","host":"api.cloudflare.com","approvalUrl":"https://example.com/account/secrets/user/cloudflareToken?allowed-host=api.cloudflare.com&request=token"},{"secretName":"slackToken","host":"slack.com","approvalUrl":"https://example.com/account/secrets/user/slackToken?allowed-host=slack.com&request=token"}]',
		nextStep:
			'Ask the user whether they want to approve these hosts for the listed secrets in the account web UI, then retry after approval.',
		missingApprovals: [
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
		],
		suggestedAction: {
			type: 'approve_secret_host',
		},
	})
})
