import { expect, test } from 'vitest'
import { type ContentBlock } from '@modelcontextprotocol/sdk/types.js'
import {
	createCapabilitySecretAccessDeniedBatchMessage,
	createCapabilitySecretAccessDeniedMessage,
	createHostSecretAccessDeniedBatchMessage,
	createMissingSecretMessage,
} from '#mcp/secrets/errors.ts'
import {
	extractRawContent,
	formatExecutionOutput,
	getExecutionErrorDetails,
} from './executor.ts'

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

test('formatExecutionOutput appends next steps from structured execution errors', () => {
	const expectedOutputs = [
		{
			error: new Error(
				createCapabilitySecretAccessDeniedMessage(
					'cloudflareToken',
					'secret_set',
					'https://example.com/account/secrets/user/cloudflareToken?capability=secret_set',
				),
			),
			nextStep:
				"Ask the user whether this capability should be allowed to use the secret. If they approve, help them add this capability name to the secret's allowed capabilities in the account secrets UI, then retry.",
		},
		{
			error: new Error(createMissingSecretMessage('missingToken')),
			nextStep:
				'Open a generated UI so the user can provide and save this secret, then retry the workflow. Do not ask the user to paste the secret into chat.',
		},
	]

	for (const { error, nextStep } of expectedOutputs) {
		expect(formatExecutionOutput({ error } as const)).toBe(
			`Error: ${error.message}\n\nNext step: ${nextStep}`,
		)
	}
})

test('extractRawContent returns MCP content blocks from sentinel result', () => {
	const content: Array<ContentBlock> = [
		{
			type: 'image',
			data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB',
			mimeType: 'image/png',
		},
		{
			type: 'text',
			text: 'Screenshot of https://example.com',
		},
	]

	expect(
		extractRawContent({
			__mcpContent: content,
		}),
	).toEqual(content)
})

test('extractRawContent returns null for non-sentinel values', () => {
	expect(extractRawContent({ result: 'not raw content' })).toBeNull()
	expect(extractRawContent('plain text')).toBeNull()
	expect(extractRawContent(null)).toBeNull()
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
					'https://example.com/account/secrets/user/cloudflareToken?allowed-host=api.cloudflare.com',
			},
			{
				secretName: 'slackToken',
				host: 'slack.com',
				approvalUrl:
					'https://example.com/account/secrets/user/slackToken?allowed-host=slack.com',
			},
		]),
	)

	expect(getExecutionErrorDetails(error)).toEqual({
		kind: 'host_approval_required_batch',
		message:
			'Secrets require host approval: [{"secretName":"cloudflareToken","host":"api.cloudflare.com","approvalUrl":"https://example.com/account/secrets/user/cloudflareToken?allowed-host=api.cloudflare.com"},{"secretName":"slackToken","host":"slack.com","approvalUrl":"https://example.com/account/secrets/user/slackToken?allowed-host=slack.com"}]',
		nextStep:
			'Ask the user whether they want to approve these hosts for the listed secrets in the account web UI, then retry after approval.',
		missingApprovals: [
			{
				secretName: 'cloudflareToken',
				host: 'api.cloudflare.com',
				approvalUrl:
					'https://example.com/account/secrets/user/cloudflareToken?allowed-host=api.cloudflare.com',
			},
			{
				secretName: 'slackToken',
				host: 'slack.com',
				approvalUrl:
					'https://example.com/account/secrets/user/slackToken?allowed-host=slack.com',
			},
		],
		suggestedAction: {
			type: 'approve_secret_host',
		},
	})
})
