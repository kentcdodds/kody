import { expect, test, vi } from 'vitest'
import { expandSecretPlaceholders } from '#mcp/fetch-gateway.ts'
import { parseHostApprovalRequiredBatchMessage } from '#mcp/secrets/errors.ts'
import {
	buildBasicAuthSecretPlaceholder,
	parseBasicAuthSecretPlaceholders,
} from '#mcp/secrets/placeholders.ts'
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

test('fetch gateway blocks or expands secret placeholders based on host approval', async () => {
	const createRequest = () =>
		new Request('https://example.com/api', {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				Authorization: 'Bearer {{secret:spotifyRefreshToken|scope=user}}',
			},
			body: JSON.stringify({
				token: '{{secret:spotifyRefreshToken|scope=user}}',
			}),
		})

	const blockedResolveSpy = vi
		.spyOn(secretService, 'resolveSecret')
		.mockResolvedValue({
			found: true,
			value: 'secret-value',
			scope: 'user',
			allowedHosts: [],
			allowedCapabilities: [],
		})
	try {
		await expandSecretPlaceholders({ request: createRequest(), props, env })
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
		blockedResolveSpy.mockRestore()
	}

	const allowedResolveSpy = vi
		.spyOn(secretService, 'resolveSecret')
		.mockResolvedValue({
			found: true,
			value: 'secret-value',
			scope: 'user',
			allowedHosts: ['example.com'],
			allowedCapabilities: [],
		})
	try {
		const transformed = await expandSecretPlaceholders({
			request: createRequest(),
			props,
			env,
		})
		expect(transformed.headers.get('Authorization')).toBe('Bearer secret-value')
		expect(await transformed.text()).toBe(
			JSON.stringify({ token: 'secret-value' }),
		)
	} finally {
		allowedResolveSpy.mockRestore()
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

test('fetch gateway derives Basic Auth header after approving both secrets', async () => {
	const placeholder = buildBasicAuthSecretPlaceholder({
		usernameSecret: 'paypalClientId',
		passwordSecret: 'paypalClientSecret',
		scope: 'user',
	})
	expect(parseBasicAuthSecretPlaceholders(`Basic ${placeholder}`)).toEqual([
		{
			username: { name: 'paypalClientId', scope: 'user' },
			password: { name: 'paypalClientSecret', scope: 'user' },
			scope: 'user',
		},
	])
	const resolveSpy = vi
		.spyOn(secretService, 'resolveSecret')
		.mockImplementation(async ({ name }) => {
			const values: Record<string, string> = {
				paypalClientId: 'client-id',
				paypalClientSecret: 'client-secret',
			}
			return {
				found: name in values,
				value: values[name] ?? null,
				scope: name in values ? 'user' : null,
				allowedHosts: name in values ? ['api-m.paypal.com'] : [],
				allowedCapabilities: [],
			}
		})
	const request = new Request('https://api-m.paypal.com/v1/oauth2/token', {
		method: 'POST',
		headers: {
			Authorization: placeholder,
			'Content-Type': 'application/x-www-form-urlencoded',
		},
		body: new URLSearchParams({
			grant_type: 'client_credentials',
		}).toString(),
	})

	try {
		const transformed = await expandSecretPlaceholders({
			request,
			props,
			env,
		})

		expect(transformed.headers.get('Authorization')).toBe(
			`Basic ${btoa('client-id:client-secret')}`,
		)
		expect(await transformed.text()).toBe('grant_type=client_credentials')
		expect(resolveSpy).toHaveBeenCalledWith(
			expect.objectContaining({
				name: 'paypalClientId',
				scope: 'user',
			}),
		)
		expect(resolveSpy).toHaveBeenCalledWith(
			expect.objectContaining({
				name: 'paypalClientSecret',
				scope: 'user',
			}),
		)

		const schemePrefixedRequest = new Request(
			'https://api-m.paypal.com/v1/oauth2/token',
			{
				headers: {
					Authorization: `basic ${placeholder}`,
				},
			},
		)
		const schemePrefixed = await expandSecretPlaceholders({
			request: schemePrefixedRequest,
			props,
			env,
		})
		expect(schemePrefixed.headers.get('Authorization')).toBe(
			`Basic ${btoa('client-id:client-secret')}`,
		)
	} finally {
		resolveSpy.mockRestore()
	}
})

test('fetch gateway reports missing secret for derived Basic Auth placeholders', async () => {
	const resolveSpy = vi
		.spyOn(secretService, 'resolveSecret')
		.mockImplementation(async ({ name }) => ({
			found: name === 'paypalClientId',
			value: name === 'paypalClientId' ? 'client-id' : null,
			scope: name === 'paypalClientId' ? 'user' : null,
			allowedHosts: name === 'paypalClientId' ? ['api-m.paypal.com'] : [],
			allowedCapabilities: [],
		}))
	const request = new Request('https://api-m.paypal.com/v1/oauth2/token', {
		headers: {
			Authorization: buildBasicAuthSecretPlaceholder({
				usernameSecret: 'paypalClientId',
				passwordSecret: 'paypalClientSecret',
				scope: 'user',
			}),
		},
	})

	try {
		await expect(
			expandSecretPlaceholders({ request, props, env }),
		).rejects.toThrow('Secret "paypalClientSecret" was not found.')
	} finally {
		resolveSpy.mockRestore()
	}
})

test.each([
	{
		blockedSecretName: 'paypalClientId',
		allowedHosts: {
			paypalClientId: [],
			paypalClientSecret: ['api-m.paypal.com'],
		},
	},
	{
		blockedSecretName: 'paypalClientSecret',
		allowedHosts: {
			paypalClientId: ['api-m.paypal.com'],
			paypalClientSecret: [],
		},
	},
])(
	'fetch gateway requires host approval for derived Basic Auth $blockedSecretName',
	async ({ blockedSecretName, allowedHosts }) => {
		const resolveSpy = vi
			.spyOn(secretService, 'resolveSecret')
			.mockImplementation(async ({ name }) => {
				const values: Record<string, string> = {
					paypalClientId: 'client-id',
					paypalClientSecret: 'client-secret',
				}
				return {
					found: name in values,
					value: values[name] ?? null,
					scope: name in values ? 'user' : null,
					allowedHosts: allowedHosts[name as keyof typeof allowedHosts] ?? [],
					allowedCapabilities: [],
				}
			})
		const request = new Request('https://api-m.paypal.com/v1/oauth2/token', {
			headers: {
				Authorization: buildBasicAuthSecretPlaceholder({
					usernameSecret: 'paypalClientId',
					passwordSecret: 'paypalClientSecret',
					scope: 'user',
				}),
			},
		})

		try {
			await expandSecretPlaceholders({ request, props, env })
			throw new Error('Expected host approval error.')
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error)
			const approvals = parseHostApprovalRequiredBatchMessage(message)
			expect(approvals).toEqual([
				expect.objectContaining({
					secretName: blockedSecretName,
					host: 'api-m.paypal.com',
					approvalUrl: expect.stringContaining(
						`/account/secrets/user/${blockedSecretName}?allowed-host=api-m.paypal.com`,
					),
				}),
			])
		} finally {
			resolveSpy.mockRestore()
		}
	},
)

test('fetch gateway resolves path-only URLs against baseUrl', async () => {
	// Node's Request rejects path-only URLs; workerd allows them for codemode outbound fetch.
	const createPathOnlyRequest = (url: string) =>
		({
			url,
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
		}) as unknown as Request

	const root = await expandSecretPlaceholders({
		request: createPathOnlyRequest('/'),
		props,
		env,
	})
	expect(root.url).toBe('https://example.com/')

	const nested = await expandSecretPlaceholders({
		request: createPathOnlyRequest('/core/log'),
		props,
		env,
	})
	expect(nested.url).toBe('https://example.com/core/log')
})
