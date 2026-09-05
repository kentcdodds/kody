import { expect, test } from 'vitest'
import {
	parseHostApprovalRequiredBatchMessage,
	parseHostApprovalRequiredMessage,
	parseMissingSecretMessage,
	parseSecretScopeUnavailableMessage,
} from './errors.ts'

test('secret error message helpers parse auth, missing-secret, and approval payloads', () => {
	expect(
		parseMissingSecretMessage('Secret "lutronPassword" was not found.'),
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
			`Secrets require host approval: ${JSON.stringify({ entries: hostEntries })}`,
		),
	).toEqual({
		entries: hostEntries,
		bulkApprovalUrl: null,
	})
	expect(
		parseHostApprovalRequiredBatchMessage(
			`Secrets require host approval: ${JSON.stringify({
				entries: hostEntries,
				bulkApprovalUrl:
					'https://example.com/connect/secrets?names=cloudflareToken,githubToken&hosts=api.cloudflare.com,api.github.com',
			})}`,
		),
	).toEqual({
		entries: hostEntries,
		bulkApprovalUrl:
			'https://example.com/connect/secrets?names=cloudflareToken,githubToken&hosts=api.cloudflare.com,api.github.com',
	})

	const scopeUnavailableMessage =
		'Secret "discordBotToken" exists in package scope for package "discord-gateway" and is not visible from this runtime.'
	expect(parseSecretScopeUnavailableMessage(scopeUnavailableMessage)).toEqual({
		secretName: 'discordBotToken',
		scope: 'package',
		packageName: 'discord-gateway',
		packageId: null,
	})
	expect(
		parseSecretScopeUnavailableMessage(
			'Secret "discordBotToken" exists in package scope for package id "pkg-1" and is not visible from this runtime.',
		),
	).toEqual({
		secretName: 'discordBotToken',
		scope: 'package',
		packageName: null,
		packageId: 'pkg-1',
	})
	expect(parseMissingSecretMessage(scopeUnavailableMessage)).toBeNull()
	expect(
		parseSecretScopeUnavailableMessage(
			'Secret "discordBotToken" was not found.',
		),
	).toBeNull()
})
