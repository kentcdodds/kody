import { expect, test, vi } from 'vitest'
import { type getCapabilityRegistryForContext } from '#mcp/capabilities/registry.ts'
import { createMcpCallerContext } from '#mcp/context.ts'
import {
	buildCodemodeFns,
	runCodemodeWithRegistry,
} from './run-codemode-registry.ts'
import * as secretService from '#mcp/secrets/service.ts'
import {
	createCapabilitySecretAccessDeniedBatchMessage,
	createCapabilitySecretAccessDeniedMessage,
} from '#mcp/secrets/errors.ts'

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

test('buildCodemodeFns tracks values that crossed secret-marked capability inputs', async () => {
	const env = {} as Env
	const callerContext = createMcpCallerContext({
		baseUrl: 'https://heykody.dev',
		user: { userId: 'user-123' },
	})
	const trackedSecretValues: Array<string> = []

	const getRegistrySpy = vi
		.spyOn(
			await import('#mcp/capabilities/registry.ts'),
			'getCapabilityRegistryForContext',
		)
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

	try {
		const codemode = await buildCodemodeFns(env, callerContext, {
			trackSecretInputValue(value) {
				trackedSecretValues.push(value)
			},
		})
		const result = await codemode.secret_set({
			name: 'spotifyAccessToken',
			value: 'fresh-access-token',
		})

		expect(result).toEqual({
			name: 'spotifyAccessToken',
		})
		expect(trackedSecretValues).toEqual(['fresh-access-token'])
	} finally {
		getRegistrySpy.mockRestore()
	}
})

test('runCodemodeWithRegistry redacts secret keys and survives cyclic results', async () => {
	const env = {} as Env
	const callerContext = createMcpCallerContext({
		baseUrl: 'https://heykody.dev',
		user: { userId: 'user-123' },
	})
	const getRegistrySpy = vi
		.spyOn(
			await import('#mcp/capabilities/registry.ts'),
			'getCapabilityRegistryForContext',
		)
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
	const createExecuteExecutorSpy = vi
		.spyOn(await import('#mcp/executor.ts'), 'createExecuteExecutor')
		.mockReturnValue({
			async execute(_wrapped, providers) {
				const provider = providers[0] as {
					fns: Record<string, (args: unknown) => Promise<unknown>>
				}
				await provider.fns.secret_set({
					name: 'spotifyAccessToken',
					value: 'fresh-access-token',
				})

				const objectResult: Record<string, unknown> = {
					'fresh-access-token key': 'fresh-access-token value',
				}
				objectResult.self = objectResult

				const arrayResult: Array<unknown> = ['fresh-access-token array']
				arrayResult.push(arrayResult)

				const errorResult = new Error('fresh-access-token error') as Error & {
					cause?: unknown
				}
				errorResult.cause = errorResult

				return {
					result: {
						objectResult,
						arrayResult,
						errorResult,
					},
					logs: ['fresh-access-token log'],
				}
			},
		} as never)

	try {
		const result = await runCodemodeWithRegistry(
			env,
			callerContext,
			`async () => {
				await codemode.secret_set({
					name: 'spotifyAccessToken',
					value: 'fresh-access-token',
				})
				return null
			}`,
		)
		const sanitized = result.result as {
			objectResult: Record<string, unknown>
			arrayResult: Array<unknown>
			errorResult: Error & { cause?: unknown }
		}

		expect(sanitized.objectResult['[REDACTED SECRET] key']).toBe(
			'[REDACTED SECRET] value',
		)
		expect(sanitized.objectResult.self).toBe(sanitized.objectResult)

		expect(sanitized.arrayResult[0]).toBe('[REDACTED SECRET] array')
		expect(sanitized.arrayResult[1]).toBe(sanitized.arrayResult)

		expect(sanitized.errorResult.message).toBe('[REDACTED SECRET] error')
		expect(sanitized.errorResult.cause).toBe(sanitized.errorResult)

		expect(result.logs).toEqual(['[REDACTED SECRET] log'])
	} finally {
		createExecuteExecutorSpy.mockRestore()
		getRegistrySpy.mockRestore()
	}
})

test('runCodemodeWithRegistry batch capability rewrite ignores Secret "…" text inside user code', async () => {
	const env = {} as Env
	const callerContext = createMcpCallerContext({
		baseUrl: 'https://heykody.dev',
		user: { userId: 'user-123' },
	})
	const resolveSecretSpy = vi
		.spyOn(secretService, 'resolveSecret')
		.mockImplementation(async (input) => {
			if (input.name === 'cloudflareToken' || input.name === 'extraSecret') {
				return {
					found: true,
					value: 'x',
					scope: 'user' as const,
					allowedHosts: [],
					allowedCapabilities: [],
				}
			}
			return { found: false }
		})
	const getRegistrySpy = vi
		.spyOn(
			await import('#mcp/capabilities/registry.ts'),
			'getCapabilityRegistryForContext',
		)
		.mockResolvedValue({
			capabilityDomains: [],
			capabilityDomainDescriptionsByName: {} as Record<string, string>,
			capabilityHandlers: {},
			capabilityList: [],
			capabilityMap: {},
			capabilitySpecs: {},
			capabilityToolDescriptors: {},
		} as Awaited<ReturnType<typeof getCapabilityRegistryForContext>>)

	const createExecuteExecutorSpy = vi
		.spyOn(await import('#mcp/executor.ts'), 'createExecuteExecutor')
		.mockReturnValue({
			async execute() {
				return {
					error: createCapabilitySecretAccessDeniedMessage(
						'cloudflareToken',
						'secret_set',
						'https://heykody.dev/account/secrets/user/cloudflareToken?capability=secret_set',
					),
				}
			},
		} as never)

	try {
		const result = await runCodemodeWithRegistry(
			env,
			callerContext,
			`async () => {
				const hint = 'Secret "extraSecret" was not found.';
				return { hint };
			}`,
		)

		expect(result.error).toBe(
			createCapabilitySecretAccessDeniedBatchMessage([
				{
					secretName: 'cloudflareToken',
					capabilityName: 'secret_set',
					approvalUrl:
						'https://heykody.dev/account/secrets/user/cloudflareToken?capability=secret_set',
				},
			]),
		)
		expect(String(result.error)).not.toContain('extraSecret')
	} finally {
		createExecuteExecutorSpy.mockRestore()
		getRegistrySpy.mockRestore()
		resolveSecretSpy.mockRestore()
	}
})
