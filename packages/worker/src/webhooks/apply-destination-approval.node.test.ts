import { expect, test } from 'vitest'
import {
	buildWebhookApplyDestinationApprovalRequiredMessage,
	buildWebhookApplyDestinationApprovalUrl,
	fingerprintHttpApplyDestination,
	toHttpApplyDestinationSnapshot,
} from './apply-destination-approval.ts'

test('http apply destination fingerprint is order-stable and change-sensitive', async () => {
	const base = {
		type: 'http' as const,
		url: 'https://hooks.example/register',
		method: 'POST' as const,
		headers: {
			'Content-Type': 'application/json',
			'X-Extra': '1',
		},
		body: '{"url":"{{webhookUrl}}"}',
		secretName: 'hooksToken',
	}
	const reordered = {
		...base,
		headers: {
			'X-Extra': '1',
			'Content-Type': 'application/json',
		},
	}
	const changedBody = {
		...base,
		body: '{"webhookUrl":"{{webhookUrl}}"}',
	}

	const left = await fingerprintHttpApplyDestination(base)
	const right = await fingerprintHttpApplyDestination(reordered)
	const changed = await fingerprintHttpApplyDestination(changedBody)
	expect(left).toBe(right)
	expect(changed).not.toBe(left)
})

test('approval url and message use the shared /connect/webhook-apply owner flow', async () => {
	const destinationInput = {
		type: 'http' as const,
		url: 'https://hooks.example/register?token={{webhookUrl}}',
		method: 'PUT' as const,
		headers: { Authorization: 'Bearer x' },
	}
	const destination = toHttpApplyDestinationSnapshot(destinationInput)
	const fingerprint = await fingerprintHttpApplyDestination(destinationInput)
	const approvalUrl = buildWebhookApplyDestinationApprovalUrl({
		baseUrl: 'https://heykody.dev',
		handle: 'whh_ep-1',
		fingerprint,
	})
	expect(approvalUrl).toContain('/connect/webhook-apply?')
	expect(approvalUrl).toContain('handle=whh_ep-1')
	expect(approvalUrl).toContain(`fingerprint=${fingerprint}`)

	const message = buildWebhookApplyDestinationApprovalRequiredMessage({
		approvalUrl,
		destination,
	})
	expect(message).toContain('/connect/secrets')
	expect(message).toContain('approval_url:')
	expect(message).toContain(approvalUrl)
	expect(message).toContain('method: PUT')
	expect(message).toContain(destination.auth)
})

test('approval message lists form-encoded {{webhookUrl}} body injection sites', async () => {
	const destinationInput = {
		type: 'http' as const,
		url: 'https://hooks.example/register',
		method: 'POST' as const,
		headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
		body: `callback=${encodeURIComponent('{{webhookUrl}}')}`,
	}
	const destination = toHttpApplyDestinationSnapshot(destinationInput)
	expect(destination.injectionSites).toContain('body')

	const fingerprint = await fingerprintHttpApplyDestination(destinationInput)
	const approvalUrl = buildWebhookApplyDestinationApprovalUrl({
		baseUrl: 'https://heykody.dev',
		handle: 'whh_ep-1',
		fingerprint,
	})
	const message = buildWebhookApplyDestinationApprovalRequiredMessage({
		approvalUrl,
		destination,
	})
	expect(message).toMatch(/injection sites:.*\bbody\b/)
	expect(message).not.toMatch(/injection sites:\s*\(none\)/)
})

test('approval snapshot ignores fragment-only url placeholders', () => {
	const destination = toHttpApplyDestinationSnapshot({
		type: 'http',
		url: 'https://hooks.example/register#{{webhookUrl}}',
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: '{"ok":true}',
	})
	expect(destination.injectionSites).not.toContain('url')
})
