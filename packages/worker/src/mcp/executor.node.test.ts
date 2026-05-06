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

	const details = getExecutionErrorDetails(error)
	expect(details).toMatchObject({
		kind: 'secret_capability_access_required',
		message: expect.any(String),
		nextStep: expect.any(String),
		secretNames: ['cloudflareToken'],
		capabilityName: 'secret_set',
		approvalUrl:
			'https://example.com/account/secrets/user/cloudflareToken?capability=secret_set',
		suggestedAction: {
			type: 'edit_secret_policy',
			policyField: 'allowed_capabilities',
		},
	})
	expect(details?.message).toContain(
		'Secret "cloudflareToken" is not allowed for capability "secret_set".',
	)
	expect(details?.message).toContain(
		'Approval link: https://example.com/account/secrets/user/cloudflareToken?capability=secret_set',
	)
	expect(details?.nextStep).toContain('allowed to use the secret')
})

test('formatExecutionOutput appends next steps from structured execution errors', () => {
	const errors = [
		new Error(
			createCapabilitySecretAccessDeniedMessage(
				'cloudflareToken',
				'secret_set',
				'https://example.com/account/secrets/user/cloudflareToken?capability=secret_set',
			),
		),
		new Error(createMissingSecretMessage('missingToken')),
	]

	for (const error of errors) {
		const output = formatExecutionOutput({ error } as const)
		expect(output).toContain(`Error: ${error.message}`)
		expect(output).toContain('\n\nNext step: ')
		expect(output).not.toBe(`Error: ${error.message}`)
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

	const details = getExecutionErrorDetails(error)
	expect(details).toMatchObject({
		kind: 'secret_capability_access_required_batch',
		message: expect.any(String),
		nextStep: expect.any(String),
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
	expect(details?.message).toContain('Secrets require capability approval:')
	expect(details?.nextStep).toContain('approve these capabilities')
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

	const details = getExecutionErrorDetails(error)
	expect(details).toMatchObject({
		kind: 'host_approval_required_batch',
		message: expect.any(String),
		nextStep: expect.any(String),
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
	expect(details?.message).toContain('Secrets require host approval:')
	expect(details?.nextStep).toContain('approve these hosts')
})
