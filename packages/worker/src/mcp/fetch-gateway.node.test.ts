import { expect, test, vi } from 'vitest'
import { expandSecretPlaceholders } from '#mcp/fetch-gateway.ts'
import { parseHostApprovalRequiredBatchMessage } from '#mcp/secrets/errors.ts'
import * as secretService from '#mcp/secrets/service.ts'

const env = {
	APP_DB: {} as D1Database,
	COOKIE_SECRET: 'test-cookie-secret',
	SECRET_STORE_KEY: 'test-secret-store-key-32-chars-minimum',
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
		const approvals = parseHostApprovalRequiredBatchMessage(message)
		expect(approvals).toEqual([
			expect.objectContaining({
				secretName: 'spotifyRefreshToken',
				host: 'example.com',
				approvalUrl: expect.stringMatching(
					/\/account\/secrets\/user\/spotifyRefreshToken\?allowed-host=example\.com$/,
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

test('fetch gateway allows absolute placeholder-free requests without props', async () => {
	const request = new Request('https://api.example.com/status', {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
		},
		body: JSON.stringify({ ok: true }),
	})

	const transformed = await expandSecretPlaceholders({
		request,
		props: undefined,
		env,
	})

	expect(transformed.url).toBe('https://api.example.com/status')
	expect(await transformed.text()).toBe(JSON.stringify({ ok: true }))
})

test('fetch gateway still requires baseUrl for path-only requests', async () => {
	// Node's Request rejects path-only URLs; workerd allows them for codemode outbound fetch.
	const request = {
		url: '/',
		method: 'GET',
		headers: new Headers(),
		redirect: 'follow',
		credentials: 'same-origin',
		mode: 'cors',
		cache: 'default',
		integrity: '',
		keepalive: false,
		signal: undefined,
		text: async () => '',
	} as unknown as Request

	await expect(
		expandSecretPlaceholders({ request, props: undefined, env }),
	).rejects.toThrow(
		'Fetch gateway could not resolve request URL "/" without a baseUrl.',
	)
})

test('fetch gateway resolves path-only URLs against baseUrl', async () => {
	// Node's Request rejects path-only URLs; workerd allows them for codemode outbound fetch.
	const request = {
		url: '/',
		method: 'GET',
		headers: new Headers(),
		redirect: 'follow',
		credentials: 'same-origin',
		mode: 'cors',
		cache: 'default',
		integrity: '',
		keepalive: false,
		signal: undefined,
		text: async () => '',
	} as unknown as Request
	const transformed = await expandSecretPlaceholders({ request, props, env })
	expect(transformed.url).toBe('https://example.com/')
})

test('fetch gateway resolves nested path-only URLs against baseUrl', async () => {
	const request = {
		url: '/core/log',
		method: 'GET',
		headers: new Headers(),
		redirect: 'follow',
		credentials: 'same-origin',
		mode: 'cors',
		cache: 'default',
		integrity: '',
		keepalive: false,
		signal: undefined,
		text: async () => '',
	} as unknown as Request
	const transformed = await expandSecretPlaceholders({ request, props, env })
	expect(transformed.url).toBe('https://example.com/core/log')
})
