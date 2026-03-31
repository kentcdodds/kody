import { expect, test, vi } from 'vitest'
import { expandSecretPlaceholders } from '#mcp/fetch-gateway.ts'
import { parseHostApprovalRequiredBatchMessage } from '#mcp/secrets/errors.ts'
import * as secretService from '#mcp/secrets/service.ts'

const env = {
	APP_DB: {} as D1Database,
	COOKIE_SECRET: 'test-cookie-secret',
}

const props = {
	baseUrl: 'https://example.com',
	userId: 'user-123',
	storageContext: null,
}

test('fetch gateway blocks placeholders when allowed hosts are empty', async () => {
	const resolveSpy = vi
		.spyOn(secretService, 'resolveSecret')
		.mockResolvedValue({
			found: true,
			value: 'secret-value',
			scope: 'user',
			allowedHosts: [],
			allowedCapabilities: [],
		})
	const request = new Request('https://example.com/api', {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			Authorization: 'Bearer {{secret:spotifyRefreshToken|scope=user}}',
		},
		body: JSON.stringify({
			token: '{{secret:spotifyRefreshToken|scope=user}}',
		}),
	})

	try {
		await expandSecretPlaceholders({ request, props, env })
		throw new Error('Expected host approval error.')
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error)
		expect(message).toContain('Secrets require host approval:')
		const approvals = parseHostApprovalRequiredBatchMessage(message)
		expect(approvals).toEqual([
			expect.objectContaining({
				secretName: 'spotifyRefreshToken',
				host: 'example.com',
				approvalUrl: expect.stringMatching(
					/\/account\/secrets\/user\/spotifyRefreshToken\?[^#]*allowed-host=example\.com[^#]*request=/,
				),
			}),
		])
	} finally {
		resolveSpy.mockRestore()
	}
})

test('fetch gateway allows placeholders for approved hosts', async () => {
	const resolveSpy = vi
		.spyOn(secretService, 'resolveSecret')
		.mockResolvedValue({
			found: true,
			value: 'secret-value',
			scope: 'user',
			allowedHosts: ['example.com'],
			allowedCapabilities: [],
		})
	const request = new Request('https://example.com/api', {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			Authorization: 'Bearer {{secret:spotifyRefreshToken|scope=user}}',
		},
		body: JSON.stringify({
			token: '{{secret:spotifyRefreshToken|scope=user}}',
		}),
	})

	try {
		const transformed = await expandSecretPlaceholders({
			request,
			props,
			env,
		})
		expect(transformed.headers.get('Authorization')).toBe('Bearer secret-value')
		expect(await transformed.text()).toBe(
			JSON.stringify({ token: 'secret-value' }),
		)
	} finally {
		resolveSpy.mockRestore()
	}
})

test('fetch gateway expands placeholders in form-urlencoded bodies', async () => {
	const resolveSpy = vi
		.spyOn(secretService, 'resolveSecret')
		.mockResolvedValue({
			found: true,
			value: 'secret value+/&=',
			scope: 'user',
			allowedHosts: ['example.com'],
			allowedCapabilities: [],
		})
	const body = new URLSearchParams({
		grant_type: 'refresh_token',
		refresh_token: '{{secret:spotifyRefreshToken|scope=user}}',
	}).toString()
	const request = new Request('https://example.com/api/token', {
		method: 'POST',
		headers: {
			'Content-Type': 'application/x-www-form-urlencoded',
		},
		body,
	})

	try {
		const transformed = await expandSecretPlaceholders({
			request,
			props,
			env,
		})
		expect(await transformed.text()).toBe(
			new URLSearchParams({
				grant_type: 'refresh_token',
				refresh_token: 'secret value+/&=',
			}).toString(),
		)
	} finally {
		resolveSpy.mockRestore()
	}
})
