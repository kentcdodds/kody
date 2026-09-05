import { expect, test } from 'vitest'
import {
	buildSecretHostApprovalUrl,
	buildSecretHostBulkApprovalUrl,
	buildSecretHostBulkApprovalUrlIfNeeded,
} from './host-approval.ts'

test('host approval URLs use /connect/secrets and support multiple hosts', () => {
	expect(
		buildSecretHostApprovalUrl({
			baseUrl: 'https://example.com',
			name: 'cloudflareToken',
			scope: 'user',
			requestedHost: 'API.Cloudflare.com',
			storageContext: null,
		}),
	).toBe(
		'https://example.com/connect/secrets?name=cloudflareToken&hosts=api.cloudflare.com',
	)

	expect(
		buildSecretHostBulkApprovalUrl({
			baseUrl: 'https://example.com',
			names: ['accessToken', 'refreshToken'],
			hosts: ['api.example.com', 'oauth.example.com', 'api.example.com'],
		}),
	).toBe(
		'https://example.com/connect/secrets?names=accessToken%2CrefreshToken&hosts=api.example.com%2Coauth.example.com',
	)

	expect(
		buildSecretHostBulkApprovalUrl({
			baseUrl: 'https://example.com',
			names: ['signingSecret'],
			hosts: ['hooks.example.com'],
			scope: 'package',
			storageContext: {
				sessionId: null,
				appId: null,
				packageId: 'pkg-1',
			},
		}),
	).toBe(
		'https://example.com/connect/secrets?name=signingSecret&hosts=hooks.example.com&scope=package&packageId=pkg-1',
	)

	expect(
		buildSecretHostBulkApprovalUrlIfNeeded({
			baseUrl: 'https://example.com',
			names: ['onlyOne'],
			hosts: ['api.example.com'],
		}),
	).toBeNull()

	expect(
		buildSecretHostBulkApprovalUrlIfNeeded({
			baseUrl: 'https://example.com',
			names: ['onlyOne'],
			hosts: ['api.example.com', 'oauth.example.com'],
		}),
	).toBe(
		'https://example.com/connect/secrets?name=onlyOne&hosts=api.example.com%2Coauth.example.com',
	)
})
