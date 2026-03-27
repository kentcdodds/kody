import { expect, test } from 'vitest'
import {
	capabilityInputSecretAuthRequiredMessage,
	createMissingSecretMessage,
	fetchSecretAuthRequiredMessage,
	isSecretAuthRequiredMessage,
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
