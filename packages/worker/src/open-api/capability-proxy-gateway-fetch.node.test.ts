import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { expect, test, vi } from 'vitest'
import {
	parseCapabilityProxyGatewayFetchArgs,
	runCapabilityProxyGatewayFetch,
} from './capability-proxy-gateway-fetch.ts'
import { ApiError } from './errors.ts'
import { bytesToBase64 } from '@kody-internal/shared/base64.ts'
import { capabilityProxyAuthenticatedFetchMaxBodyBytes } from './capability-proxy-authenticated-fetch.ts'
import { McpCallerError } from '#mcp/caller-error.ts'

const authorizeLocalExecuteOwnedPackageId = vi.hoisted(() => vi.fn())
const executeGatewayFetch = vi.hoisted(() => vi.fn())

vi.mock('./capability-proxy-package-grants.ts', () => ({
	authorizeLocalExecuteOwnedPackageId: (...args: Array<unknown>) =>
		authorizeLocalExecuteOwnedPackageId(...args),
}))

vi.mock('#mcp/fetch-gateway.ts', () => ({
	executeGatewayFetch: (...args: Array<unknown>) =>
		executeGatewayFetch(...args),
}))

test('parseCapabilityProxyGatewayFetchArgs accepts valid requests and rejects mixed bodies', () => {
	expect(
		parseCapabilityProxyGatewayFetchArgs([
			{
				request: {
					url: 'https://api.usefathom.com/v1/sites',
					method: 'GET',
					headers: {
						authorization: 'Bearer {{secret:demoToken|scope=user}}',
					},
				},
			},
		]),
	).toEqual({
		request: {
			url: 'https://api.usefathom.com/v1/sites',
			method: 'GET',
			headers: {
				authorization: 'Bearer {{secret:demoToken|scope=user}}',
			},
		},
	})
	expect(
		parseCapabilityProxyGatewayFetchArgs([
			{
				packageId: 'pkg-1',
				request: {
					url: 'https://api.usefathom.com/v1/sites',
					bodyBase64: bytesToBase64(new TextEncoder().encode('x')),
				},
			},
		]),
	).toEqual({
		packageId: 'pkg-1',
		request: {
			url: 'https://api.usefathom.com/v1/sites',
			method: 'GET',
			bodyBase64: bytesToBase64(new TextEncoder().encode('x')),
		},
	})
	expect(() =>
		parseCapabilityProxyGatewayFetchArgs([
			{
				request: {
					url: 'https://example.com/',
					body: 'text',
					bodyBase64: bytesToBase64(new Uint8Array([1])),
				},
			},
		]),
	).toThrow(ApiError)
	expect(() =>
		parseCapabilityProxyGatewayFetchArgs([
			{
				request: {
					url: 'https://example.com/',
					body: 'x'.repeat(capabilityProxyAuthenticatedFetchMaxBodyBytes + 1),
				},
			},
		]),
	).toThrow(ApiError)
})

test('runCapabilityProxyGatewayFetch hops to executeGatewayFetch with stamped package authority', async () => {
	authorizeLocalExecuteOwnedPackageId.mockResolvedValue('pkg-owned')
	executeGatewayFetch.mockImplementation(
		async (input: { request: Request }) => {
			expect(input.request.headers.get('authorization')).toBe(
				'Bearer {{secret:demoToken|scope=user}}',
			)
			return new Response(JSON.stringify({ ok: true }), {
				status: 200,
				headers: { 'content-type': 'application/json' },
			})
		},
	)

	const result = await runCapabilityProxyGatewayFetch({
		ctx: {
			env: { APP_DB: {} },
			callerContext: {
				baseUrl: 'https://heykody.dev',
				user: {
					userId: ownerIdFromStored('user-1'),
					email: 'user@example.com',
				},
				storageContext: null,
			},
		} as never,
		args: [
			{
				packageId: 'pkg-owned',
				request: {
					url: 'https://api.usefathom.com/v1/sites',
					headers: {
						authorization: 'Bearer {{secret:demoToken|scope=user}}',
					},
				},
			},
		],
	})

	expect(authorizeLocalExecuteOwnedPackageId).toHaveBeenCalledWith(
		expect.objectContaining({
			orgUserId: ownerIdFromStored('user-1'),
			packageId: 'pkg-owned',
		}),
	)
	expect(executeGatewayFetch).toHaveBeenCalledTimes(1)
	const gatewayArg = executeGatewayFetch.mock.calls[0]?.[0] as {
		request: Request
		props: { grantedSecretAuthorityPackageIds?: Array<string> }
	}
	expect(gatewayArg.props.grantedSecretAuthorityPackageIds).toEqual([
		'pkg-owned',
	])
	expect(result.status).toBe(200)
	expect(JSON.parse(atob(result.bodyBase64))).toEqual({ ok: true })
})

test('runCapabilityProxyGatewayFetch propagates missing-secret caller errors from the gateway', async () => {
	executeGatewayFetch.mockRejectedValue(
		new McpCallerError('Secret "demoToken" was not found.'),
	)

	await expect(
		runCapabilityProxyGatewayFetch({
			ctx: {
				env: { APP_DB: {} },
				callerContext: {
					baseUrl: 'https://heykody.dev',
					user: {
						userId: ownerIdFromStored('user-1'),
						email: 'user@example.com',
					},
					storageContext: null,
				},
			} as never,
			args: [
				{
					request: {
						url: 'https://api.usefathom.com/v1/sites',
						headers: {
							authorization: 'Bearer {{secret:demoToken|scope=user}}',
						},
					},
				},
			],
		}),
	).rejects.toMatchObject({
		message: 'Secret "demoToken" was not found.',
	})
	expect(executeGatewayFetch).toHaveBeenCalledTimes(1)
})

test('runCapabilityProxyGatewayFetch without packageId does not grant secret authority', async () => {
	executeGatewayFetch.mockResolvedValue(
		new Response(JSON.stringify({ ok: true }), {
			status: 200,
			headers: { 'content-type': 'application/json' },
		}),
	)

	await runCapabilityProxyGatewayFetch({
		ctx: {
			env: { APP_DB: {} },
			callerContext: {
				baseUrl: 'https://heykody.dev',
				user: {
					userId: ownerIdFromStored('user-1'),
					email: 'user@example.com',
				},
				storageContext: null,
			},
		} as never,
		args: [
			{
				request: {
					url: 'https://api.usefathom.com/v1/sites',
					headers: {
						authorization: 'Bearer {{secret:demoToken|scope=user}}',
					},
				},
			},
		],
	})

	expect(authorizeLocalExecuteOwnedPackageId).not.toHaveBeenCalled()
	const gatewayArg = executeGatewayFetch.mock.calls[0]?.[0] as {
		props: {
			grantedSecretAuthorityPackageIds?: Array<string>
			storageContext: { packageId: string | null }
		}
		request: Request
	}
	expect(gatewayArg.props.grantedSecretAuthorityPackageIds).toBeUndefined()
	expect(gatewayArg.props.storageContext.packageId).toBeNull()
	expect(gatewayArg.request.headers.get('x-kody-secret-authority')).toBeNull()
})
