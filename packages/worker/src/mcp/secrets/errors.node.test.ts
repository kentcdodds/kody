import { expect, test } from 'vitest'
import {
	createCapabilitySecretAccessDeniedMessage,
	createCapabilitySecretAccessDeniedBatchMessage,
	createHostSecretAccessDeniedBatchMessage,
	createMissingSecretMessage,
	createSecretScopeUnavailableMessage,
	parseCapabilityAccessRequiredBatchMessage,
	parseCapabilityAccessRequiredMessage,
	parseHostApprovalRequiredBatchMessage,
	parseHostApprovalRequiredMessage,
	parseMissingSecretMessage,
	parseSecretScopeUnavailableMessage,
} from './errors.ts'

test('secret error message helpers parse auth, missing-secret, and approval payloads', () => {
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
	expect(capabilityMessage).toContain(
		'ask the user whether to approve that capability in the account secrets UI',
	)
	expect(capabilityMessage).not.toContain(
		'add "secret_set" to the secret\'s allowed capabilities',
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

	const scopeUnavailableMessage = createSecretScopeUnavailableMessage([
		{
			secretName: 'discordBotToken',
			scope: 'package',
			packageId: 'pkg-1',
			packageName: 'discord-gateway',
			sessionId: null,
			editorUrl:
				'https://example.com/account/secrets/package/pkg-1/discordBotToken',
		},
	])
	expect(scopeUnavailableMessage).toContain(
		'Either invoke this work through the owning package',
	)
	expect(scopeUnavailableMessage).toContain(
		'https://example.com/account/secrets/package/pkg-1/discordBotToken',
	)
	expect(parseSecretScopeUnavailableMessage(scopeUnavailableMessage)).toEqual({
		secretName: 'discordBotToken',
		scope: 'package',
		packageName: 'discord-gateway',
		packageId: null,
	})
	const packageIdOnlyMessage = createSecretScopeUnavailableMessage([
		{
			secretName: 'discordBotToken',
			scope: 'package',
			packageId: 'pkg-1',
			packageName: null,
			sessionId: null,
			editorUrl:
				'https://example.com/account/secrets/package/pkg-1/discordBotToken',
		},
	])
	expect(packageIdOnlyMessage).toContain('package id "pkg-1"')
	expect(parseSecretScopeUnavailableMessage(packageIdOnlyMessage)).toEqual({
		secretName: 'discordBotToken',
		scope: 'package',
		packageName: null,
		packageId: 'pkg-1',
	})
	expect(parseMissingSecretMessage(scopeUnavailableMessage)).toBeNull()
	expect(
		parseCapabilityAccessRequiredMessage(scopeUnavailableMessage),
	).toBeNull()
	expect(
		parseSecretScopeUnavailableMessage(
			createMissingSecretMessage('discordBotToken'),
		),
	).toBeNull()
	expect(parseSecretScopeUnavailableMessage(capabilityMessage)).toBeNull()
})
