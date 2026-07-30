import { getErrorMessage } from '@kody-internal/shared/error-message.ts'
import { expect, test, vi } from 'vitest'
import {
	executeGatewayFetch,
	expandSecretPlaceholders,
	secretResolutionHeaderName,
} from '#mcp/fetch-gateway.ts'
import {
	parseHostApprovalRequiredBatchMessage,
	parsePackageAccessRequiredMessage,
} from '#mcp/secrets/errors.ts'
import { buildBasicAuthSecretPlaceholder } from '#mcp/secrets/placeholders.ts'
import * as secretService from '#mcp/secrets/service.ts'
import * as communityRepo from '#worker/community/repo.ts'
import * as packageRepo from '#worker/package-registry/repo.ts'

/**
 * Minimal D1 stub for the entitlement reads/writes executeGatewayFetch
 * performs (account reverse-resolution `first()` and the conditional
 * counter upsert `run()`); secret resolution itself is spied at the
 * service layer. Both statements must bind the acting userId — the stub
 * fails loudly when a query drops the per-user scoping.
 */
const env = {
	APP_DB: {
		prepare(query: string) {
			const normalizedQuery = query.replace(/\s+/g, ' ').trim().toLowerCase()
			return {
				bind(...params: Array<unknown>) {
					return {
						async run() {
							if (
								normalizedQuery.includes(
									'insert into entitlement_daily_counters',
								) &&
								params[0] !== 'user-123'
							) {
								throw new Error(
									'Entitlement counter upsert must bind the acting userId.',
								)
							}
							return { meta: { changes: 1 } }
						},
						async first() {
							if (
								normalizedQuery.includes('where stable_user_id') &&
								params[0] !== 'user-123'
							) {
								throw new Error(
									'Account reverse-resolution must bind the acting userId.',
								)
							}
							return null
						},
					}
				},
			}
		},
	} as unknown as D1Database,
	COOKIE_SECRET: 'test-cookie-secret',
	SECRET_STORE_KEY: 'test-secret-store-key-32-chars-minimum',
}

const props = {
	baseUrl: 'https://example.com',
	userId: 'user-123',
	email: null,
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
		const message = getErrorMessage(error)
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

test('fetch gateway requires package approval before resolving user secrets', async () => {
	const request = () =>
		new Request('https://example.com/api', {
			headers: {
				Authorization: 'Bearer {{secret:userToken|scope=user}}',
			},
		})
	const packageProps = {
		...props,
		storageContext: {
			sessionId: null,
			appId: 'pkg-1',
			packageId: 'pkg-1',
			storageId: 'pkg-1',
		},
	}
	const packageSpy = vi
		.spyOn(packageRepo, 'getSavedPackageById')
		.mockResolvedValue({
			id: 'pkg-1',
			userId: 'user-123',
			kodyId: 'example-package',
			name: '@user/example-package',
			description: '',
			tags: [],
			searchText: null,
			hasApp: false,
			hidden: false,
			isPrivate: false,
			sourceId: 'source-1',
			createdAt: '2026-01-01T00:00:00.000Z',
			updatedAt: '2026-01-01T00:00:00.000Z',
		})
	const forkSpy = vi
		.spyOn(communityRepo, 'getCommunityForkByForkedPackageId')
		.mockResolvedValue({
			id: 'fork-1',
			listingId: 'listing-1',
			forkerUserId: 'user-123',
			originCommit: 'abc123',
			forkedPackageId: 'pkg-1',
			forkedSourceId: 'source-1',
			targetKodyId: 'example-package',
			createdAt: '2026-01-01T00:00:00.000Z',
			adoptedAt: null,
			adoptionNote: null,
		})
	const resolveSpy = vi
		.spyOn(secretService, 'resolveSecret')
		.mockResolvedValueOnce({
			found: true,
			value: 'secret-value',
			scope: 'user',
			allowedHosts: ['example.com'],
			allowedCapabilities: [],
			allowedPackages: [],
		})
		.mockResolvedValueOnce({
			found: true,
			value: 'secret-value',
			scope: 'user',
			allowedHosts: ['example.com'],
			allowedCapabilities: [],
			allowedPackages: ['pkg-1'],
		})

	try {
		await expect(
			expandSecretPlaceholders({
				request: request(),
				props: packageProps,
				env,
			}),
		).rejects.toSatisfy((error: unknown) => {
			const parsed = parsePackageAccessRequiredMessage(getErrorMessage(error))
			return parsed?.packageName === 'example-package'
		})
		const transformed = await expandSecretPlaceholders({
			request: request(),
			props: packageProps,
			env,
		})
		expect(transformed.headers.get('Authorization')).toBe('Bearer secret-value')
		expect(packageSpy).toHaveBeenCalledTimes(1)
		expect(forkSpy).toHaveBeenCalledTimes(1)
		expect(resolveSpy).toHaveBeenCalledTimes(2)
	} finally {
		packageSpy.mockRestore()
		forkSpy.mockRestore()
		resolveSpy.mockRestore()
	}
})

test('opt-out header sends placeholders literally, strips itself, and never resolves secrets', async () => {
	const resolveSpy = vi.spyOn(secretService, 'resolveSecret')
	const request = new Request('https://discord.com/api/channels/1/messages', {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			[secretResolutionHeaderName]: 'off',
		},
		body: JSON.stringify({
			content: 'Use {{secret:name}} in your fetch call.',
		}),
	})

	try {
		const transformed = await expandSecretPlaceholders({ request, props, env })
		expect(transformed.headers.get(secretResolutionHeaderName)).toBeNull()
		expect(await transformed.text()).toBe(
			JSON.stringify({ content: 'Use {{secret:name}} in your fetch call.' }),
		)
		expect(transformed.url).toBe('https://discord.com/api/channels/1/messages')
		expect(resolveSpy).not.toHaveBeenCalled()
	} finally {
		resolveSpy.mockRestore()
	}
})

test('opt-out header value "on" resolves normally and is stripped; unknown values fail loudly', async () => {
	const resolveSpy = vi
		.spyOn(secretService, 'resolveSecret')
		.mockResolvedValue({
			found: true,
			value: 'secret-value',
			scope: 'user',
			allowedHosts: ['example.com'],
			allowedCapabilities: [],
		})
	try {
		const onRequest = new Request('https://example.com/api', {
			method: 'POST',
			headers: {
				Authorization: 'Bearer {{secret:spotifyRefreshToken|scope=user}}',
				[secretResolutionHeaderName]: 'on',
			},
			body: '{}',
		})
		const transformed = await expandSecretPlaceholders({
			request: onRequest,
			props,
			env,
		})
		expect(transformed.headers.get('Authorization')).toBe('Bearer secret-value')
		expect(transformed.headers.get(secretResolutionHeaderName)).toBeNull()

		const invalidRequest = new Request('https://example.com/api', {
			headers: { [secretResolutionHeaderName]: 'of' },
		})
		await expect(
			expandSecretPlaceholders({ request: invalidRequest, props, env }),
		).rejects.toThrow(`Invalid ${secretResolutionHeaderName} header value "of"`)
	} finally {
		resolveSpy.mockRestore()
	}
})

test('fetch gateway preserves request bodies and honors opt-out for text and binary payloads', async () => {
	const resolveSpy = vi
		.spyOn(secretService, 'resolveSecret')
		.mockResolvedValue({
			found: true,
			value: 'secret-value',
			scope: 'user',
			allowedHosts: ['discord.com', 'example.com'],
			allowedCapabilities: [],
		})
	try {
		const binaryBytes = new Uint8Array([
			0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0xfe, 0x00, 0x01,
		])
		const boundary = '----TestBoundary123'
		const encoder = new TextEncoder()
		const prefix = encoder.encode(
			`--${boundary}\r\nContent-Disposition: form-data; name="files[0]"; filename="image.png"\r\nContent-Type: image/png\r\n\r\n`,
		)
		const suffix = encoder.encode(`\r\n--${boundary}--\r\n`)
		const multipartBody = new Uint8Array(
			prefix.length + binaryBytes.length + suffix.length,
		)
		multipartBody.set(prefix, 0)
		multipartBody.set(binaryBytes, prefix.length)
		multipartBody.set(suffix, prefix.length + binaryBytes.length)

		const multipartRequest = new Request(
			'https://discord.com/api/channels/1/messages',
			{
				method: 'POST',
				headers: {
					Authorization: 'Bot {{secret:discordBotToken|scope=user}}',
					'Content-Type': `multipart/form-data; boundary=${boundary}`,
				},
				body: multipartBody,
			},
		)
		const transformedMultipart = await expandSecretPlaceholders({
			request: multipartRequest,
			props,
			env,
		})
		expect(transformedMultipart.headers.get('Authorization')).toBe(
			'Bot secret-value',
		)
		expect(new Uint8Array(await transformedMultipart.arrayBuffer())).toEqual(
			multipartBody,
		)

		const bomBody = new Uint8Array([
			0xef,
			0xbb,
			0xbf,
			...encoder.encode('{"note":"bom-prefixed json"}'),
		])
		const bomRequest = new Request('https://example.com/api', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: bomBody,
		})
		const transformedBom = await expandSecretPlaceholders({
			request: bomRequest,
			props,
			env,
		})
		expect(new Uint8Array(await transformedBom.arrayBuffer())).toEqual(bomBody)

		const placeholderText = encoder.encode('{{secret:name|scope=user}}')
		const binaryPlaceholderBody = new Uint8Array(placeholderText.length + 2)
		binaryPlaceholderBody[0] = 0xff
		binaryPlaceholderBody.set(placeholderText, 1)
		binaryPlaceholderBody[binaryPlaceholderBody.length - 1] = 0xfe
		const binaryPlaceholderRequest = new Request('https://example.com/upload', {
			method: 'PUT',
			body: binaryPlaceholderBody,
		})
		const transformedBinaryPlaceholder = await expandSecretPlaceholders({
			request: binaryPlaceholderRequest,
			props,
			env,
		})
		expect(resolveSpy).toHaveBeenCalledTimes(1)
		resolveSpy.mockClear()
		expect(
			new Uint8Array(await transformedBinaryPlaceholder.arrayBuffer()),
		).toEqual(binaryPlaceholderBody)

		const optOutBinaryBody = new Uint8Array([
			0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10,
		])
		const optOutBinaryRequest = new Request('https://example.com/upload', {
			method: 'POST',
			headers: { [secretResolutionHeaderName]: 'off' },
			body: optOutBinaryBody,
		})
		const transformedOptOutBinary = await expandSecretPlaceholders({
			request: optOutBinaryRequest,
			props,
			env,
		})
		expect(resolveSpy).not.toHaveBeenCalled()
		expect(new Uint8Array(await transformedOptOutBinary.arrayBuffer())).toEqual(
			optOutBinaryBody,
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

test('fetch gateway derives Basic Auth header and enforces host approval', async () => {
	const placeholder = buildBasicAuthSecretPlaceholder({
		usernameSecret: 'paypalClientId',
		passwordSecret: 'paypalClientSecret',
		scope: 'user',
	})
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

		resolveSpy.mockImplementation(async ({ name }) => ({
			found: name === 'paypalClientId',
			value: name === 'paypalClientId' ? 'client-id' : null,
			scope: name === 'paypalClientId' ? 'user' : null,
			allowedHosts: name === 'paypalClientId' ? ['api-m.paypal.com'] : [],
			allowedCapabilities: [],
		}))
		const missingSecretRequest = new Request(
			'https://api-m.paypal.com/v1/oauth2/token',
			{
				headers: { Authorization: placeholder },
			},
		)
		await expect(
			expandSecretPlaceholders({ request: missingSecretRequest, props, env }),
		).rejects.toThrow('Secret "paypalClientSecret" was not found.')

		for (const blockedSecretName of ['paypalClientId', 'paypalClientSecret']) {
			const allowedHosts =
				blockedSecretName === 'paypalClientId'
					? { paypalClientId: [], paypalClientSecret: ['api-m.paypal.com'] }
					: { paypalClientId: ['api-m.paypal.com'], paypalClientSecret: [] }
			resolveSpy.mockImplementation(async ({ name }) => {
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
			const blockedRequest = new Request(
				'https://api-m.paypal.com/v1/oauth2/token',
				{
					headers: { Authorization: placeholder },
				},
			)
			await expect(
				expandSecretPlaceholders({ request: blockedRequest, props, env }),
			).rejects.toSatisfy((error: unknown) => {
				const approvals = parseHostApprovalRequiredBatchMessage(
					getErrorMessage(error),
				)
				return (
					approvals?.[0]?.secretName === blockedSecretName &&
					approvals?.[0]?.host === 'api-m.paypal.com'
				)
			})
		}
	} finally {
		resolveSpy.mockRestore()
	}
})

test('fetch gateway resolves path-only URLs against baseUrl', async () => {
	// Node's Request rejects path-only URLs; workerd allows them for kody outbound fetch.
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

test('gateway fetch records outbound_fetch usage metering', async () => {
	const usageModule = await import('#worker/usage/record-usage.ts')
	const recordUsageSpy = vi
		.spyOn(usageModule, 'recordUsage')
		.mockResolvedValue(undefined)
	const fetchStub = vi.fn()
	const waitUntil = vi.fn()

	try {
		fetchStub.mockResolvedValue(
			new Response('ok', {
				status: 200,
				headers: { 'content-length': '1234' },
			}),
		)
		const successResponse = await executeGatewayFetch({
			env,
			props,
			request: new Request('https://api.example.com/data'),
			globalFetch: fetchStub,
			waitUntil,
		})
		expect(successResponse.status).toBe(200)
		expect(fetchStub).toHaveBeenCalledTimes(1)
		expect(waitUntil).toHaveBeenCalledTimes(1)
		expect(recordUsageSpy).toHaveBeenCalledTimes(1)
		expect(recordUsageSpy).toHaveBeenCalledWith(env, {
			userId: 'user-123',
			eventType: 'outbound_fetch',
			entityId: 'api.example.com',
			durationMs: expect.any(Number),
			bytes: 1234,
			outcome: 'success',
		})

		recordUsageSpy.mockClear()
		fetchStub.mockClear()
		waitUntil.mockClear()

		fetchStub.mockResolvedValue(new Response('upstream error', { status: 502 }))
		const upstreamErrorResponse = await executeGatewayFetch({
			env,
			props,
			request: new Request('https://api.example.com/upstream-error'),
			globalFetch: fetchStub,
			waitUntil,
		})
		expect(upstreamErrorResponse.status).toBe(502)
		expect(recordUsageSpy).toHaveBeenCalledTimes(1)
		expect(recordUsageSpy).toHaveBeenCalledWith(
			env,
			expect.objectContaining({
				userId: 'user-123',
				eventType: 'outbound_fetch',
				entityId: 'api.example.com',
				outcome: 'success',
			}),
		)
		expect(recordUsageSpy.mock.calls[0]?.[1]?.bytes).toBeUndefined()

		recordUsageSpy.mockClear()
		fetchStub.mockClear()
		waitUntil.mockClear()

		fetchStub.mockResolvedValue(new Response('ok', { status: 200 }))
		await executeGatewayFetch({
			env,
			props,
			request: new Request('https://api.example.com/no-length'),
			globalFetch: fetchStub,
		})
		expect(recordUsageSpy).toHaveBeenCalledTimes(1)
		expect(recordUsageSpy).toHaveBeenCalledWith(
			env,
			expect.objectContaining({
				userId: 'user-123',
				eventType: 'outbound_fetch',
				entityId: 'api.example.com',
				outcome: 'success',
			}),
		)
		expect(recordUsageSpy.mock.calls[0]?.[1]?.bytes).toBeUndefined()

		recordUsageSpy.mockClear()
		fetchStub.mockClear()
		waitUntil.mockClear()

		const fetchError = new Error('network failed')
		fetchStub.mockRejectedValue(fetchError)
		await expect(
			executeGatewayFetch({
				env,
				props,
				request: new Request('https://api.example.com/fail'),
				globalFetch: fetchStub,
			}),
		).rejects.toThrow('network failed')
		expect(recordUsageSpy).toHaveBeenCalledTimes(1)
		expect(recordUsageSpy).toHaveBeenCalledWith(
			env,
			expect.objectContaining({
				userId: 'user-123',
				eventType: 'outbound_fetch',
				entityId: 'api.example.com',
				outcome: 'error',
			}),
		)
		expect(recordUsageSpy.mock.calls[0]?.[1]?.bytes).toBeUndefined()

		recordUsageSpy.mockClear()
		fetchStub.mockClear()
		waitUntil.mockClear()

		await expect(
			executeGatewayFetch({
				env,
				props: { ...props, baseUrl: '' },
				request: new Request('https://original.example.com/api'),
				globalFetch: fetchStub,
			}),
		).rejects.toThrow('Fetch gateway requires a non-empty baseUrl in props.')
		expect(fetchStub).not.toHaveBeenCalled()
		expect(recordUsageSpy).toHaveBeenCalledTimes(1)
		expect(recordUsageSpy).toHaveBeenCalledWith(
			env,
			expect.objectContaining({
				userId: 'user-123',
				eventType: 'outbound_fetch',
				entityId: 'original.example.com',
				outcome: 'error',
			}),
		)

		recordUsageSpy.mockClear()
		fetchStub.mockClear()
		waitUntil.mockClear()

		// Error path with waitUntil available: metering is deferred, never blocks.
		fetchStub.mockRejectedValue(new Error('network failed with waitUntil'))
		await expect(
			executeGatewayFetch({
				env,
				props,
				request: new Request('https://api.example.com/fail-deferred'),
				globalFetch: fetchStub,
				waitUntil,
			}),
		).rejects.toThrow('network failed with waitUntil')
		expect(waitUntil).toHaveBeenCalledTimes(1)
		expect(recordUsageSpy).toHaveBeenCalledTimes(1)
		expect(recordUsageSpy.mock.calls[0]?.[1]).toMatchObject({
			entityId: 'api.example.com',
			outcome: 'error',
		})

		recordUsageSpy.mockClear()
		fetchStub.mockClear()
		waitUntil.mockClear()

		fetchStub.mockResolvedValue(new Response('ok'))
		await executeGatewayFetch({
			env,
			props: { ...props, userId: null },
			request: new Request('https://api.example.com/anonymous'),
			globalFetch: fetchStub,
		})
		expect(recordUsageSpy).not.toHaveBeenCalled()
	} finally {
		recordUsageSpy.mockRestore()
	}
})

test('gateway fetch metering never derives a hostname from expanded secret placeholders', async () => {
	const usageModule = await import('#worker/usage/record-usage.ts')
	const recordUsageSpy = vi
		.spyOn(usageModule, 'recordUsage')
		.mockResolvedValue(undefined)
	const resolveSpy = vi
		.spyOn(secretService, 'resolveSecret')
		.mockResolvedValue({
			found: true,
			value: 'resolved-secret-value',
			scope: 'user',
			allowedHosts: ['example.com'],
			allowedCapabilities: [],
		})
	// Node's Request rejects path-only URLs; workerd allows them for kody outbound fetch.
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
	const fetchStub = vi.fn(async () => new Response('ok'))

	try {
		// Path-only URL without placeholders: the transformed (baseUrl) host is
		// literal and safe to meter.
		await executeGatewayFetch({
			env,
			props,
			request: createPathOnlyRequest('/api/status'),
			globalFetch: fetchStub,
		})
		expect(recordUsageSpy).toHaveBeenCalledTimes(1)
		expect(recordUsageSpy.mock.calls[0]?.[1]).toMatchObject({
			entityId: 'example.com',
			outcome: 'success',
		})

		// Unparseable original URL containing a placeholder: the expanded host
		// could contain secret material, so no hostname is metered.
		recordUsageSpy.mockClear()
		fetchStub.mockClear()
		await executeGatewayFetch({
			env,
			props,
			request: createPathOnlyRequest('/api?key={{secret:token}}'),
			globalFetch: fetchStub,
		})
		expect(fetchStub).toHaveBeenCalledTimes(1)
		expect(recordUsageSpy).toHaveBeenCalledTimes(1)
		expect(recordUsageSpy.mock.calls[0]?.[1]).toMatchObject({
			entityId: '',
			outcome: 'success',
		})
	} finally {
		recordUsageSpy.mockRestore()
		resolveSpy.mockRestore()
	}
})

test('fetch gateway aborts hung outbound fetches at the default deadline', async () => {
	const fetchStub = vi.fn((_request: Request) => {
		return new Promise<Response>((_resolve, reject) => {
			_request.signal.addEventListener(
				'abort',
				() => {
					reject(
						_request.signal.reason ??
							new DOMException('The operation was aborted.', 'AbortError'),
					)
				},
				{ once: true },
			)
		})
	})
	const startedAtMs = Date.now()
	await expect(
		executeGatewayFetch({
			env,
			props,
			request: new Request('https://example.com/slow'),
			globalFetch: fetchStub as unknown as typeof fetch,
			timeoutMs: 40,
		}),
	).rejects.toSatisfy((error: unknown) => {
		const name =
			error && typeof error === 'object' && 'name' in error
				? String(error.name)
				: ''
		return name === 'TimeoutError' || name === 'AbortError'
	})
	expect(Date.now() - startedAtMs).toBeLessThan(500)
	expect(fetchStub).toHaveBeenCalledTimes(1)
	const outbound = fetchStub.mock.calls[0]?.[0]
	expect(outbound?.signal.aborted).toBe(true)
})
