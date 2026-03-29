import { expect, test, vi } from 'vitest'
import { type getCapabilityRegistryForContext } from '#mcp/capabilities/registry.ts'
import { createMcpCallerContext } from '#mcp/context.ts'
import {
	buildCodemodeFns,
	runCodemodeWithRegistry,
} from './run-codemode-registry.ts'
import * as secretService from '#mcp/secrets/service.ts'

test('buildCodemodeFns resolves annotated home capability secret placeholders', async () => {
	let toolArguments: Record<string, unknown> | null = null
	const env = {
		HOME_CONNECTOR_SESSION: {
			idFromName(name: string) {
				return name
			},
			get() {
				return {
					async fetch(input: string | URL | Request, init?: RequestInit) {
						const url = new URL(
							typeof input === 'string'
								? input
								: input instanceof URL
									? input.toString()
									: input.url,
						)
						if (url.pathname.endsWith('/snapshot')) {
							return Response.json({
								connectorId: 'default',
								connectedAt: '2026-03-27T00:00:00.000Z',
								lastSeenAt: '2026-03-27T00:00:01.000Z',
								tools: [
									{
										name: 'lutron_set_credentials',
										title: 'Set Lutron Credentials',
										description: 'Store Lutron credentials.',
										inputSchema: {
											type: 'object',
											properties: {
												processorId: { type: 'string' },
												username: {
													type: 'string',
													'x-kody-secret': true,
												},
												password: {
													type: 'string',
													'x-kody-secret': true,
												},
											},
											required: ['processorId', 'username', 'password'],
										},
									},
								],
							})
						}

						if (url.pathname.endsWith('/rpc/tools-call')) {
							const requestBody = JSON.parse(String(init?.body ?? '{}')) as {
								arguments?: Record<string, unknown>
							}
							toolArguments = requestBody.arguments ?? null
							return Response.json({
								structuredContent: {
									ok: true,
								},
							})
						}

						throw new Error(`Unexpected fetch to ${url.pathname}`)
					},
				}
			},
		},
	} as unknown as Env

	const codemode = await buildCodemodeFns(
		env,
		createMcpCallerContext({
			baseUrl: 'https://heykody.dev',
			user: { userId: 'user-123' },
			homeConnectorId: 'default',
		}),
		{
			resolveSecretValue: async (secret, capabilityName) =>
				`${secret.name}-${capabilityName}-resolved`,
		},
	)

	await codemode.home_lutron_set_credentials({
		processorId: 'lutron-192-168-0-41',
		username: '{{secret:lutronUsername|scope=user}}',
		password: '{{secret:lutronPassword|scope=user}}',
	})

	expect(toolArguments).toEqual({
		processorId: 'lutron-192-168-0-41',
		username: 'lutronUsername-home_lutron_set_credentials-resolved',
		password: 'lutronPassword-home_lutron_set_credentials-resolved',
	})
})

test('buildCodemodeFns denies capability secret placeholders for disallowed capabilities', async () => {
	const resolveSecretSpy = vi
		.spyOn(secretService, 'resolveSecret')
		.mockResolvedValue({
			found: true,
			value: 'lutronUsername-resolved',
			scope: 'user',
			allowedHosts: [],
			allowedCapabilities: ['some_other_capability'],
		})
	const env = {
		HOME_CONNECTOR_SESSION: {
			idFromName(name: string) {
				return name
			},
			get() {
				return {
					async fetch(input: string | URL | Request) {
						const url = new URL(
							typeof input === 'string'
								? input
								: input instanceof URL
									? input.toString()
									: input.url,
						)
						if (url.pathname.endsWith('/snapshot')) {
							return Response.json({
								connectorId: 'default',
								connectedAt: '2026-03-27T00:00:00.000Z',
								lastSeenAt: '2026-03-27T00:00:01.000Z',
								tools: [
									{
										name: 'lutron_set_credentials',
										title: 'Set Lutron Credentials',
										description: 'Store Lutron credentials.',
										inputSchema: {
											type: 'object',
											properties: {
												username: {
													type: 'string',
													'x-kody-secret': true,
												},
											},
											required: ['username'],
										},
									},
								],
							})
						}

						throw new Error(`Unexpected fetch to ${url.pathname}`)
					},
				}
			},
		},
	} as unknown as Env

	const codemode = await buildCodemodeFns(
		env,
		createMcpCallerContext({
			baseUrl: 'https://heykody.dev',
			user: { userId: 'user-123' },
			homeConnectorId: 'default',
		}),
	)

	try {
		await expect(
			codemode.home_lutron_set_credentials({
				username: '{{secret:lutronUsername|scope=user}}',
			}),
		).rejects.toThrow(
			'Secret "lutronUsername" is not allowed for capability "home_lutron_set_credentials". If this capability should be able to use the secret, ask the user whether to add "home_lutron_set_credentials" to the secret\'s allowed capabilities in the account secrets UI, then retry after they approve that policy change. Approval link: https://heykody.dev/account/secrets/user/lutronUsername?capability=home_lutron_set_credentials',
		)
		expect(resolveSecretSpy).toHaveBeenCalledWith(
			expect.objectContaining({
				name: 'lutronUsername',
				scope: 'user',
				userId: 'user-123',
			}),
		)
	} finally {
		resolveSecretSpy.mockRestore()
	}
})

test('runCodemodeWithRegistry redacts values that crossed secret-marked capability inputs', async () => {
	const env = {
		LOADER: {},
	} as unknown as Env
	const executorExports = {
		CodemodeFetchGateway() {
			return {}
		},
	} as unknown as typeof import('cloudflare:workers').exports
	const callerContext = createMcpCallerContext({
		baseUrl: 'https://heykody.dev',
		user: { userId: 'user-123' },
	})

	const getRegistrySpy = vi
		.spyOn(await import('#mcp/capabilities/registry.ts'), 'getCapabilityRegistryForContext')
		.mockResolvedValue({
			capabilityDomains: [],
			capabilityDomainDescriptionsByName: {} as Record<string, string>,
			capabilityHandlers: {},
			capabilityList: [
				{
					name: 'secret_set',
					domain: 'secrets',
					description: 'Store a secret.',
					keywords: [],
					readOnly: false,
					idempotent: false,
					destructive: false,
					inputSchema: {
						type: 'object',
						properties: {
							name: { type: 'string' },
							value: { type: 'string', 'x-kody-secret': true },
						},
						required: ['name', 'value'],
					},
					outputSchema: {
						type: 'object',
						properties: {
							name: { type: 'string' },
						},
					},
					async handler(args: Record<string, unknown>) {
						return {
							name: args.name,
						}
					},
				},
			],
			capabilityMap: {
				secret_set: {
					name: 'secret_set',
					domain: 'secrets',
					description: 'Store a secret.',
					keywords: [],
					readOnly: false,
					idempotent: false,
					destructive: false,
					inputSchema: {
						type: 'object',
						properties: {
							name: { type: 'string' },
							value: { type: 'string', 'x-kody-secret': true },
						},
						required: ['name', 'value'],
					},
					outputSchema: {
						type: 'object',
						properties: {
							name: { type: 'string' },
						},
					},
					async handler(args: Record<string, unknown>) {
						return {
							name: args.name,
						}
					},
				},
			},
			capabilitySpecs: {},
			capabilityToolDescriptors: {
				secret_set: {
					description: 'Store a secret.',
					inputSchema: {
						type: 'object',
						properties: {
							name: { type: 'string' },
							value: { type: 'string', 'x-kody-secret': true },
						},
						required: ['name', 'value'],
					},
					outputSchema: {
						type: 'object',
						properties: {
							name: { type: 'string' },
						},
					},
				},
			},
		} as Awaited<ReturnType<typeof getCapabilityRegistryForContext>>)

	const executeSpy = vi
		.spyOn(await import('#mcp/executor.ts'), 'createExecuteExecutor')
		.mockReturnValue({
			async execute() {
				return {
					result: {
						saved: true,
						echoedValue: 'fresh-access-token',
						nested: {
							message: 'Bearer fresh-access-token',
						},
					},
					logs: ['saved fresh-access-token'],
				}
			},
		} as Awaited<ReturnType<typeof import('#mcp/executor.ts').createExecuteExecutor>>)

	try {
		const result = await runCodemodeWithRegistry(
			env,
			callerContext,
			`async () => {
				await codemode.secret_set({
					name: 'spotifyAccessToken',
					value: 'fresh-access-token',
				})
				return { ok: true }
			}`,
			undefined,
			executorExports,
		)

		expect(result.error).toBeUndefined()
		expect(result.result).toEqual({
			saved: true,
			echoedValue: '[REDACTED SECRET]',
			nested: {
				message: 'Bearer [REDACTED SECRET]',
			},
		})
		expect(result.logs).toEqual(['saved [REDACTED SECRET]'])
	} finally {
		getRegistrySpy.mockRestore()
		executeSpy.mockRestore()
	}
})
