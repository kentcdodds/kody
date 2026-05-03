import { expect, test, vi } from 'vitest'
import { type getCapabilityRegistryForContext } from '#mcp/capabilities/registry.ts'
import { createMcpCallerContext } from '#mcp/context.ts'
import { buildKodyModuleBundle } from '#worker/package-runtime/module-graph.ts'
import {
	buildCodemodeFns,
	createWorkflowTools,
	runCodemodeWithRegistry,
	runBundledModuleWithRegistry,
	runModuleWithRegistry,
} from './run-codemode-registry.ts'
import { PackageSecretMountError } from '#mcp/secrets/package-access.ts'
import * as packageAccess from '#mcp/secrets/package-access.ts'
import * as secretService from '#mcp/secrets/service.ts'
import {
	createCapabilitySecretAccessDeniedBatchMessage,
	createCapabilitySecretAccessDeniedMessage,
} from '#mcp/secrets/errors.ts'

test('createWorkflowTools creates package workflow instances from package context', async () => {
	const created: Array<WorkflowInstanceCreateOptions<unknown>> = []
	const workflowTools = createWorkflowTools({
		env: {
			PACKAGE_WORKFLOWS: {
				get: async () => {
					throw new Error('not found')
				},
				create: async (options?: WorkflowInstanceCreateOptions<unknown>) => {
					if (!options) throw new Error('missing options')
					created.push(options)
					return {
						id: options.id ?? 'generated',
						status: async () => ({ status: 'queued' }),
					} as WorkflowInstance
				},
			} as Workflow<unknown>,
		} as Env,
		callerContext: {
			baseUrl: 'https://app.example.com',
			user: {
				userId: 'user-1',
				email: 'me@example.com',
				displayName: 'Me',
			},
			storageContext: null,
			repoContext: null,
		},
		packageContext: {
			packageId: 'pkg-1',
			kodyId: 'shade-automation',
			sourceId: 'source-1',
		},
	})

	const result = await workflowTools?.create({
		workflowName: 'shade-event',
		exportName: './run-event',
		runAt: '2026-05-03T12:00:00.000Z',
		idempotencyKey: 'event-key',
		params: { eventId: 'event-1' },
	})

	expect(result).toMatchObject({
		ok: true,
		workflow_name: 'shade-event',
		export_name: './run-event',
		run_at: '2026-05-03T12:00:00.000Z',
	})
	expect(created).toHaveLength(1)
	expect(created[0]?.params).toEqual(
		expect.objectContaining({
			userId: 'user-1',
			packageId: 'pkg-1',
			kodyId: 'shade-automation',
			sourceId: 'source-1',
			workflowName: 'shade-event',
			params: { eventId: 'event-1' },
		}),
	)
})

test('runModuleWithRegistry preserves caller-provided workflow tools', async () => {
	const env = {} as Env
	const callerContext = createMcpCallerContext({
		baseUrl: 'https://app.example.com',
		user: {
			userId: 'user-1',
			email: 'me@example.com',
			displayName: 'Me',
		},
		storageContext: null,
	})
	const customWorkflowTools = {
		create: vi.fn(async () => ({ ok: true, id: 'custom-workflow' })),
	}
	let providerFns: Record<string, (args: unknown) => Promise<unknown>> | null =
		null
	const createExecuteExecutorSpy = vi
		.spyOn(await import('#mcp/executor.ts'), 'createExecuteExecutor')
		.mockReturnValue({
			async execute(wrapped, providers) {
				expect(wrapped).toContain(
					'codemode.package_workflow_create(input ?? {})',
				)
				providerFns = (
					providers[0] as {
						fns: Record<string, (args: unknown) => Promise<unknown>>
					}
				).fns
				return {
					result: 'ok',
					logs: [],
				}
			},
		} as never)

	try {
		await runModuleWithRegistry(
			env,
			callerContext,
			`import { workflows } from 'kody:runtime'
export default async function run() {
	await workflows.create({
		workflowName: 'shade-event',
		exportName: './run-event',
		runAt: '2026-05-03T12:00:00.000Z',
		idempotencyKey: 'event-key',
	})
}`,
			undefined,
			{
				packageContext: {
					packageId: 'pkg-1',
					kodyId: 'shade-automation',
					sourceId: 'source-1',
				},
				workflowTools: customWorkflowTools,
			},
		)
		await expect(
			providerFns?.package_workflow_create({ workflowName: 'custom' }),
		).resolves.toEqual({ ok: true, id: 'custom-workflow' })
		expect(customWorkflowTools.create).toHaveBeenCalledWith({
			workflowName: 'custom',
		})
	} finally {
		createExecuteExecutorSpy.mockRestore()
	}
})

vi.mock('#worker/package-runtime/module-graph.ts', () => ({
	buildKodyModuleBundle: vi.fn(async () => ({
		mainModule: 'entry.js',
		modules: {
			'entry.js': 'export default async function run() { return null }',
		},
	})),
}))

test('buildCodemodeFns resolves annotated home capability secret placeholders', async () => {
	let toolArguments: Record<string, unknown> | null = null
	const env = {
		HOME_CONNECTOR_SESSION: {
			idFromName(name: string) {
				return name
			},
			get() {
				return {
					async getSnapshot() {
						return {
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
						}
					},
					async rpcCallTool(name: string, args: Record<string, unknown>) {
						toolArguments = args
						return {
							structuredContent: {
								ok: true,
							},
						}
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
					async getSnapshot() {
						return {
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
						}
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

test('buildCodemodeFns rejects storage codemode tools that collide with capabilities', async () => {
	const env = {
		STORAGE_RUNNER: {
			idFromName(name: string) {
				return name
			},
			get() {
				return {}
			},
		},
	} as unknown as Env
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
					name: 'storage_get',
					domain: 'storage',
					description: 'Capability that collides with a storage helper.',
					keywords: [],
					readOnly: true,
					idempotent: true,
					destructive: false,
					inputSchema: {
						type: 'object',
						properties: {},
					},
					outputSchema: {
						type: 'object',
						properties: {},
					},
					async handler() {
						return { ok: true }
					},
				},
			],
			capabilityMap: {
				storage_get: {
					name: 'storage_get',
					domain: 'storage',
					description: 'Capability that collides with a storage helper.',
					keywords: [],
					readOnly: true,
					idempotent: true,
					destructive: false,
					inputSchema: {
						type: 'object',
						properties: {},
					},
					outputSchema: {
						type: 'object',
						properties: {},
					},
					async handler() {
						return { ok: true }
					},
				},
			},
			capabilitySpecs: {},
			capabilityToolDescriptors: {
				storage_get: {
					description: 'Capability that collides with a storage helper.',
					inputSchema: {
						type: 'object',
						properties: {},
					},
					outputSchema: {
						type: 'object',
						properties: {},
					},
				},
			},
		} as Awaited<ReturnType<typeof getCapabilityRegistryForContext>>)

	try {
		await expect(
			buildCodemodeFns(env, callerContext, {
				storageTools: {
					userId: 'user-123',
					storageId: 'exec:test-storage',
					writable: false,
				},
			}),
		).rejects.toThrow(
			'Codemode helper "storage_get" collides with a capability.',
		)
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
		const result = await runModuleWithRegistry(
			env,
			callerContext,
			`import { codemode } from 'kody:runtime'

export default async function run() {
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
		const result = await runModuleWithRegistry(
			env,
			callerContext,
			`export default async function run() {
	const hint = 'Secret "extraSecret" was not found.'
	return { hint }
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

test('runCodemodeWithRegistry routes module-style code through the bundled runtime', async () => {
	const env = {} as Env
	const callerContext = createMcpCallerContext({
		baseUrl: 'https://heykody.dev',
		user: { userId: 'user-123' },
	})
	const buildBundleMock = vi.mocked(buildKodyModuleBundle)
	buildBundleMock.mockClear()
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
					result: 'ok',
					logs: [],
				}
			},
		} as never)

	try {
		const code = `import { codemode } from 'kody:runtime'

export default async function run() {
	return await codemode.meta_list_capabilities({})
}`
		const result = await runCodemodeWithRegistry(env, callerContext, code)

		expect(result.result).toBe('ok')
		expect(buildBundleMock).toHaveBeenCalledTimes(1)
		expect(buildBundleMock).toHaveBeenCalledWith(
			expect.objectContaining({
				sourceFiles: {
					'entry.ts': code,
				},
				entryPoint: 'entry.ts',
			}),
		)
	} finally {
		createExecuteExecutorSpy.mockRestore()
		getRegistrySpy.mockRestore()
	}
})

test('runCodemodeWithRegistry strips markdown fences before bundling module code', async () => {
	const env = {} as Env
	const callerContext = createMcpCallerContext({
		baseUrl: 'https://heykody.dev',
		user: { userId: 'user-123' },
	})
	const buildBundleMock = vi.mocked(buildKodyModuleBundle)
	buildBundleMock.mockClear()
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
					result: 'ok',
					logs: [],
				}
			},
		} as never)

	try {
		const fencedCode = `\`\`\`ts
import { codemode } from 'kody:runtime'

export default async function run() {
	return await codemode.meta_list_capabilities({})
}
\`\`\``
		const result = await runCodemodeWithRegistry(env, callerContext, fencedCode)

		expect(result.result).toBe('ok')
		expect(buildBundleMock).toHaveBeenCalledTimes(1)
		expect(buildBundleMock).toHaveBeenCalledWith(
			expect.objectContaining({
				sourceFiles: {
					'entry.ts': `import { codemode } from 'kody:runtime'

export default async function run() {
	return await codemode.meta_list_capabilities({})
}
`,
				},
			}),
		)
	} finally {
		createExecuteExecutorSpy.mockRestore()
		getRegistrySpy.mockRestore()
	}
})

test('runCodemodeWithRegistry routes TypeScript module syntax through the bundled runtime', async () => {
	const env = {} as Env
	const callerContext = createMcpCallerContext({
		baseUrl: 'https://heykody.dev',
		user: { userId: 'user-123' },
	})
	const buildBundleMock = vi.mocked(buildKodyModuleBundle)
	buildBundleMock.mockClear()
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
					result: 'ok',
					logs: [],
				}
			},
		} as never)

	try {
		const code = `import type { ExecuteResult } from '@cloudflare/codemode'

type ModuleOutput = ExecuteResult | null

export default async function run(): Promise<ModuleOutput> {
	return null
}`
		const result = await runCodemodeWithRegistry(env, callerContext, code)

		expect(result.result).toBe('ok')
		expect(buildBundleMock).toHaveBeenCalledTimes(1)
		expect(buildBundleMock).toHaveBeenCalledWith(
			expect.objectContaining({
				sourceFiles: {
					'entry.ts': code,
				},
			}),
		)
	} finally {
		createExecuteExecutorSpy.mockRestore()
		getRegistrySpy.mockRestore()
	}
})

test('runCodemodeWithRegistry forwards package context for module syntax', async () => {
	const env = {} as Env
	const callerContext = createMcpCallerContext({
		baseUrl: 'https://heykody.dev',
		user: { userId: 'user-123' },
		storageContext: {
			sessionId: null,
			appId: 'package-123',
			storageId: 'package-123',
		},
	})
	const buildBundleMock = vi.mocked(buildKodyModuleBundle)
	buildBundleMock.mockClear()
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
	let providerFns: Record<string, (args: unknown) => Promise<unknown>> | null =
		null
	const resolvePackageMountedSecretSpy = vi
		.spyOn(packageAccess, 'resolvePackageMountedSecret')
		.mockImplementation(async ({ alias }) => {
			if (alias === 'missing-token') {
				throw new PackageSecretMountError(
					'Secret "missing-token" was not found.',
				)
			}
			return {
				alias,
				name: 'discordBotTokenKentPersonalAutomation',
				value: 'bot-token',
				scope: 'user',
				packageId: 'package-123',
				kodyId: 'discord-gateway',
			}
		})
	const createExecuteExecutorSpy = vi
		.spyOn(await import('#mcp/executor.ts'), 'createExecuteExecutor')
		.mockReturnValue({
			async execute(_input, providers) {
				providerFns = (
					providers[0] as {
						fns: Record<string, (args: unknown) => Promise<unknown>>
					}
				).fns
				return {
					result: 'ok',
					logs: [],
				}
			},
		} as never)

	try {
		const code = `import { packageContext } from 'kody:runtime'

export default async function run() {
	return packageContext?.packageId ?? null
}`
		const result = await runCodemodeWithRegistry(
			env,
			callerContext,
			code,
			undefined,
			{
				packageContext: {
					packageId: 'package-123',
					kodyId: 'discord-gateway',
				},
			},
		)

		expect(result.result).toBe('ok')
		expect(providerFns).not.toBeNull()
		await expect(
			providerFns?.package_secret_has({ alias: 'token' }),
		).resolves.toEqual({
			has: true,
		})
		await expect(
			providerFns?.package_secret_has({ alias: 'missing-token' }),
		).resolves.toEqual({
			has: false,
		})
		await expect(
			providerFns?.package_secret_get({ alias: 'token' }),
		).resolves.toEqual({
			value: 'bot-token',
		})
		expect(resolvePackageMountedSecretSpy).toHaveBeenCalledWith({
			env,
			callerContext,
			packageId: 'package-123',
			alias: 'token',
		})
	} finally {
		createExecuteExecutorSpy.mockRestore()
		resolvePackageMountedSecretSpy.mockRestore()
		getRegistrySpy.mockRestore()
	}
})

test('runCodemodeWithRegistry keeps legacy snippet execution for non-module code', async () => {
	const env = {} as Env
	const callerContext = createMcpCallerContext({
		baseUrl: 'https://heykody.dev',
		user: { userId: 'user-123' },
	})
	const buildBundleMock = vi.mocked(buildKodyModuleBundle)
	buildBundleMock.mockClear()
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
					result: 'ok',
					logs: [],
				}
			},
		} as never)

	try {
		const result = await runCodemodeWithRegistry(
			env,
			callerContext,
			'return "ok"',
		)

		expect(result.result).toBe('ok')
		expect(buildBundleMock).not.toHaveBeenCalled()
	} finally {
		createExecuteExecutorSpy.mockRestore()
		getRegistrySpy.mockRestore()
	}
})

test('runBundledModuleWithRegistry injects service helpers and custom timeout', async () => {
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
			capabilityList: [],
			capabilityMap: {},
			capabilitySpecs: {},
			capabilityToolDescriptors: {},
		} as Awaited<ReturnType<typeof getCapabilityRegistryForContext>>)
	let providerFns: Record<string, (args: unknown) => Promise<unknown>> | null =
		null
	const createExecuteExecutorSpy = vi
		.spyOn(await import('#mcp/executor.ts'), 'createExecuteExecutor')
		.mockImplementation((input) => {
			expect(input.timeoutMs).toBe(300_000)
			return {
				async execute(_source, providers) {
					providerFns = (
						providers[0] as {
							fns: Record<string, (args: unknown) => Promise<unknown>>
						}
					).fns
					return {
						result: 'ok',
						logs: [],
					}
				},
			} as never
		})

	try {
		const result = await runBundledModuleWithRegistry(
			env,
			callerContext,
			{
				mainModule: 'entry.js',
				modules: {
					'entry.js': 'export default async () => "ok"',
				},
			},
			undefined,
			{
				serviceContext: {
					serviceName: 'realtime-supervisor',
				},
				serviceTools: {
					getStatus: async () => ({ status: 'running' }),
					shouldStop: async () => false,
					setAlarm: async () => ({
						ok: true,
						scheduled_at: '2026-04-25T00:00:00.000Z',
					}),
					clearAlarm: async () => ({ ok: true }),
				},
				executorTimeoutMs: 300_000,
			},
		)

		expect(result.result).toBe('ok')
		expect(providerFns).not.toBeNull()
		await expect(providerFns?.service_get_status({})).resolves.toEqual({
			status: 'running',
		})
		await expect(providerFns?.service_should_stop({})).resolves.toEqual({
			shouldStop: false,
		})
		await expect(
			providerFns?.service_set_alarm({ runAt: '2026-04-25T00:00:00.000Z' }),
		).resolves.toEqual({
			ok: true,
			scheduled_at: '2026-04-25T00:00:00.000Z',
		})
		await expect(providerFns?.service_clear_alarm({})).resolves.toEqual({
			ok: true,
		})
	} finally {
		createExecuteExecutorSpy.mockRestore()
		getRegistrySpy.mockRestore()
	}
})

test('runBundledModuleWithRegistry injects email helpers', async () => {
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
			capabilityList: [],
			capabilityMap: {},
			capabilitySpecs: {},
			capabilityToolDescriptors: {},
		} as Awaited<ReturnType<typeof getCapabilityRegistryForContext>>)
	let providerFns: Record<string, (args: unknown) => Promise<unknown>> | null =
		null
	const createExecuteExecutorSpy = vi
		.spyOn(await import('#mcp/executor.ts'), 'createExecuteExecutor')
		.mockReturnValue({
			async execute(_source, providers) {
				providerFns = (
					providers[0] as {
						fns: Record<string, (args: unknown) => Promise<unknown>>
					}
				).fns
				return {
					result: 'ok',
					logs: [],
				}
			},
		} as never)

	try {
		const result = await runBundledModuleWithRegistry(
			env,
			callerContext,
			{
				mainModule: 'entry.js',
				modules: {
					'entry.js': 'export default async () => "ok"',
				},
			},
			undefined,
			{
				emailTools: {
					getMessage: async (messageId) => ({
						id: messageId,
						subject: 'Hello',
					}),
					getAttachment: async (attachmentId) => ({
						id: attachmentId,
						text: 'hello',
					}),
				},
			},
		)

		expect(result.result).toBe('ok')
		expect(providerFns).not.toBeNull()
		await expect(
			providerFns?.email_message_get({
				message_id: 'message-1',
			}),
		).resolves.toEqual({
			id: 'message-1',
			subject: 'Hello',
		})
		await expect(
			providerFns?.email_attachment_get({
				attachment_id: 'attachment-1',
			}),
		).resolves.toEqual({
			id: 'attachment-1',
			text: 'hello',
		})
	} finally {
		createExecuteExecutorSpy.mockRestore()
		getRegistrySpy.mockRestore()
	}
})

test('runBundledModuleWithRegistry injects workflow helper when custom workflow tools are provided', async () => {
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
			capabilityList: [],
			capabilityMap: {},
			capabilitySpecs: {},
			capabilityToolDescriptors: {},
		} as Awaited<ReturnType<typeof getCapabilityRegistryForContext>>)
	let providerFns: Record<string, (args: unknown) => Promise<unknown>> | null =
		null
	const createExecuteExecutorSpy = vi
		.spyOn(await import('#mcp/executor.ts'), 'createExecuteExecutor')
		.mockReturnValue({
			async execute(wrapped, providers) {
				expect(wrapped).toContain('const workflows = {')
				expect(wrapped).toContain(
					'workflows: typeof workflows === \'undefined\' ? null : workflows',
				)
				providerFns = (
					providers[0] as {
						fns: Record<string, (args: unknown) => Promise<unknown>>
					}
				).fns
				return {
					result: 'ok',
					logs: [],
				}
			},
		} as never)

	try {
		const result = await runBundledModuleWithRegistry(
			env,
			callerContext,
			{
				mainModule: 'entry.js',
				modules: {
					'entry.js': 'export default async () => "ok"',
				},
			},
			undefined,
			{
				workflowTools: {
					create: async (input) => ({ ok: true, input }),
				},
			},
		)

		expect(result.result).toBe('ok')
		expect(providerFns).not.toBeNull()
		await expect(
			providerFns?.package_workflow_create({ workflowName: 'custom' }),
		).resolves.toEqual({
			ok: true,
			input: { workflowName: 'custom' },
		})
	} finally {
		createExecuteExecutorSpy.mockRestore()
		getRegistrySpy.mockRestore()
	}
})

test('runModuleWithRegistry injects email helpers for module syntax', async () => {
	const env = {} as Env
	const callerContext = createMcpCallerContext({
		baseUrl: 'https://heykody.dev',
		user: { userId: 'user-123' },
	})
	const buildBundleMock = vi.mocked(buildKodyModuleBundle)
	buildBundleMock.mockClear()
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
	let providerFns: Record<string, (args: unknown) => Promise<unknown>> | null =
		null
	const createExecuteExecutorSpy = vi
		.spyOn(await import('#mcp/executor.ts'), 'createExecuteExecutor')
		.mockReturnValue({
			async execute(_source, providers) {
				providerFns = (
					providers[0] as {
						fns: Record<string, (args: unknown) => Promise<unknown>>
					}
				).fns
				return {
					result: { id: 'message-1', subject: 'Hello' },
					logs: [],
				}
			},
		} as never)

	try {
		const code = `import { email } from 'kody:runtime'

export default async function run() {
	return await email.getMessage('message-1')
}`
		const result = await runModuleWithRegistry(
			env,
			callerContext,
			code,
			undefined,
			{
				emailTools: {
					getMessage: async (messageId) => ({
						id: messageId,
						subject: 'Hello',
					}),
					getAttachment: async (attachmentId) => ({
						id: attachmentId,
						text: 'hello',
					}),
				},
			},
		)

		expect(result.result).toEqual({
			id: 'message-1',
			subject: 'Hello',
		})
		expect(buildBundleMock).toHaveBeenCalledTimes(1)
		expect(providerFns).not.toBeNull()
		await expect(
			providerFns?.email_message_get({
				message_id: 'message-1',
			}),
		).resolves.toEqual({
			id: 'message-1',
			subject: 'Hello',
		})
		await expect(
			providerFns?.email_attachment_get({
				attachment_id: 'attachment-1',
			}),
		).resolves.toEqual({
			id: 'attachment-1',
			text: 'hello',
		})
	} finally {
		createExecuteExecutorSpy.mockRestore()
		getRegistrySpy.mockRestore()
	}
})
