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
	limitExecutionResultValue,
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
		const plainOutput = `Error: ${error.message}`
		expect(output).toContain(plainOutput)
		expect(output.length).toBeGreaterThan(plainOutput.length)
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

test('limitExecutionResultValue truncates strings on UTF-8 codepoint boundaries', () => {
	const oneByteLimit = limitExecutionResultValue('éabc', 1)
	expect(oneByteLimit).toMatchObject({
		value: '',
		returnedBytes: 5,
		truncated: true,
	})

	const threeByteLimit = limitExecutionResultValue('éabc', 3)
	expect(threeByteLimit).toMatchObject({
		value: 'éa',
		returnedBytes: 5,
		truncated: true,
	})
	expect(
		new TextEncoder().encode(String(threeByteLimit.value)).byteLength,
	).toBe(3)
})

test('getExecutionErrorDetails returns batch capability approvals', () => {
	const error = new Error(
		createCapabilitySecretAccessDeniedBatchMessage([
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
})
