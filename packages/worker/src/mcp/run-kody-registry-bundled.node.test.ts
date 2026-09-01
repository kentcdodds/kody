import { expect, test, vi } from 'vitest'
import { silenceIncidentalRuntimeWarnings } from '#worker/test-support/incidental-runtime-warnings.ts'
import { type getCapabilityRegistryForContext } from '#mcp/capabilities/registry.ts'
import { createMcpCallerContext } from '#mcp/context.ts'
import type * as ModuleGraph from '#worker/package-runtime/module-graph.ts'
import { runBundledModuleWithRegistry } from './run-kody-registry.ts'
import * as mcpExecutor from '#mcp/executor.ts'
import { createFakeRunLogNamespace } from '#worker/test-support/run-kody-registry.ts'

vi.mock('#worker/package-runtime/module-graph.ts', async () => {
	const actual = await vi.importActual<typeof ModuleGraph>(
		'#worker/package-runtime/module-graph.ts',
	)
	return {
		...actual,
		buildKodyModuleBundle: vi.fn(async () => ({
			mainModule: 'entry.js',
			modules: {
				'entry.js':
					'export default async function main(input = {}) { return input }',
			},
		})),
	}
})
test('runBundledModuleWithRegistry passes params and injects runtime helpers', async () => {
	silenceIncidentalRuntimeWarnings()
	const created: Array<WorkflowInstanceCreateOptions<unknown>> = []
	const runLog = createFakeRunLogNamespace()
	const workflowEnv = {
		APP_DB: {
			prepare(query: string) {
				return {
					bind() {
						return {
							async first() {
								if (query.includes('COUNT(*) AS count')) return { count: 0 }
								return null
							},
							async all() {
								throw new Error(`Unsupported all query: ${query}`)
							},
							async run() {
								throw new Error(`Unsupported run query: ${query}`)
							},
						}
					},
				}
			},
		} as unknown as D1Database,
		RUN_LOG: runLog.namespace,
		DYNAMIC_CALLABLE_WORKFLOWS: {
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
	} as Env
	const env = {} as Env
	const callerContext = createMcpCallerContext({
		baseUrl: 'https://heykody.dev',
		user: { userId: 'user-123' },
	})
	const emptyRegistry = {
		capabilityDomains: [],
		capabilityDomainDescriptionsByName: {} as Record<string, string>,
		capabilityHandlers: {},
		capabilityList: [],
		capabilityMap: {},
		capabilitySpecs: {},
		capabilityToolDescriptors: {},
	} as Awaited<ReturnType<typeof getCapabilityRegistryForContext>>
	const paramsBundle = {
		mainModule: 'entry.js',
		modules: {
			'entry.js':
				'export default async function main(input = {}) { return input }',
		},
	}
	const bundle = {
		mainModule: 'entry.js',
		modules: {
			'entry.js': 'export default async () => "ok"',
		},
	}
	const getRegistrySpy = vi
		.spyOn(
			await import('#mcp/capabilities/registry.ts'),
			'getCapabilityRegistryForContext',
		)
		.mockResolvedValue(emptyRegistry)
	let providerFns: Record<string, (args: unknown) => Promise<unknown>> | null =
		null
	let packageBridgeFns: Record<
		string,
		(args: unknown) => Promise<unknown>
	> | null = null
	const createExecuteExecutorSpy = vi
		.spyOn(await import('#mcp/executor.ts'), 'createExecuteExecutor')
		.mockReturnValue({
			async execute() {
				return {
					result: { room: 'office' },
					logs: [],
				}
			},
		} as never)

	try {
		const paramsResult = await runBundledModuleWithRegistry(
			env,
			callerContext,
			paramsBundle,
			{ room: 'office' },
			{
				skipCapabilityRegistry: true,
			},
		)
		expect(paramsResult.result).toEqual({ room: 'office' })

		createExecuteExecutorSpy.mockImplementation(() => {
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

		createExecuteExecutorSpy.mockImplementation(
			() =>
				({
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
				}) as never,
		)

		const emailResult = await runBundledModuleWithRegistry(
			env,
			callerContext,
			bundle,
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
		expect(emailResult.result).toBe('ok')
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

		createExecuteExecutorSpy.mockImplementation(
			() =>
				({
					async execute(_wrapped, providers) {
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
				}) as never,
		)

		const workflowResult = await runBundledModuleWithRegistry(
			env,
			callerContext,
			bundle,
			undefined,
			{
				workflowTools: {
					create: async (input) => ({ ok: true, input }),
				},
			},
		)
		expect(workflowResult.result).toBe('ok')
		expect(providerFns).not.toBeNull()
		await expect(
			providerFns?.package_workflow_create({ workflowName: 'custom' }),
		).resolves.toEqual({
			ok: true,
			input: { workflowName: 'custom' },
		})

		createExecuteExecutorSpy.mockImplementation(
			() =>
				({
					async execute(_wrapped, providers) {
						// Main provider + packages bridge + static-call meter
						// bridge (bound whenever the run has a user).
						expect(providers).toHaveLength(3)
						providerFns = (
							providers[0] as {
								fns: Record<string, (args: unknown) => Promise<unknown>>
							}
						).fns
						packageBridgeFns = (
							providers[1] as {
								fns: Record<string, (args: unknown) => Promise<unknown>>
							}
						).fns
						return {
							result: 'ok',
							logs: [],
						}
					},
				}) as never,
		)

		const packageResult = await runBundledModuleWithRegistry(
			env,
			callerContext,
			bundle,
			undefined,
			{
				packageInvokeTools: {
					invoke: async (input) => ({ ok: true, input }),
				},
			},
		)
		expect(packageResult.result).toBe('ok')
		expect(providerFns).not.toBeNull()
		expect(packageBridgeFns).not.toBeNull()
		await expect(
			packageBridgeFns?.invoke({
				specifier:
					'kody:@kentcdodds/discord-general-chat/handle-discord-message-created',
				options: {},
			}),
		).resolves.toEqual({
			ok: true,
			input: {
				specifier:
					'kody:@kentcdodds/discord-general-chat/handle-discord-message-created',
				options: {},
			},
		})

		createExecuteExecutorSpy.mockImplementation(
			() =>
				({
					async execute(_wrapped, providers) {
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
				}) as never,
		)

		await runBundledModuleWithRegistry(
			workflowEnv,
			callerContext,
			bundle,
			undefined,
			{
				packageContext: null,
			},
		)
		await expect(
			providerFns?.package_workflow_create({
				runAt: '2026-05-03T12:00:00.000Z',
				idempotencyKey: 'execute-smoke',
				code: 'export default async function main(p){ return { ok: true, p }; }',
				params: { greeting: 'hello' },
			}),
		).resolves.toMatchObject({
			ok: true,
			source_type: 'inline',
			status: 'queued',
		})
		expect(created[0]?.params).toEqual(
			expect.objectContaining({
				sourceType: 'inline',
				userId: 'user-123',
				params: { greeting: 'hello' },
			}),
		)
	} finally {
		createExecuteExecutorSpy.mockRestore()
		getRegistrySpy.mockRestore()
	}
})

test('runBundledModuleWithRegistry uses a prebuilt capability registry without reloading', async () => {
	silenceIncidentalRuntimeWarnings()
	const env = {} as Env
	const callerContext = createMcpCallerContext({
		baseUrl: 'https://heykody.dev',
		user: { userId: 'user-123' },
	})
	const emptyRegistry = {
		capabilityDomains: [],
		capabilityDomainDescriptionsByName: {} as Record<string, string>,
		capabilityHandlers: {},
		capabilityList: [],
		capabilityMap: {},
		capabilitySpecs: {},
		capabilityToolDescriptors: {},
	} as Awaited<ReturnType<typeof getCapabilityRegistryForContext>>
	let loadCount = 0
	const getRegistrySpy = vi
		.spyOn(
			await import('#mcp/capabilities/registry.ts'),
			'getCapabilityRegistryForContext',
		)
		.mockImplementation(async () => {
			loadCount += 1
			return emptyRegistry
		})
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
	const bundle = {
		mainModule: 'entry.js',
		modules: {
			'entry.js': 'export default async () => "ok"',
		},
	}

	try {
		await runBundledModuleWithRegistry(env, callerContext, bundle, undefined, {
			capabilityRegistry: emptyRegistry,
		})
		expect(loadCount).toBe(0)

		await runBundledModuleWithRegistry(env, callerContext, bundle)
		expect(loadCount).toBe(1)
	} finally {
		createExecuteExecutorSpy.mockRestore()
		getRegistrySpy.mockRestore()
	}
})

test('runBundledModuleWithRegistry records package_export usage for bundled runs with package context', async () => {
	silenceIncidentalRuntimeWarnings()
	const env = {} as Env
	const callerContext = createMcpCallerContext({
		baseUrl: 'https://heykody.dev',
		user: {
			userId: 'user-metered',
			email: 'metered@example.com',
			displayName: 'Metered User',
		},
	})
	const bundle = {
		mainModule: 'entry.js',
		modules: {
			'entry.js': 'export default async () => "ok"',
		},
	}
	const packageContext = {
		packageId: 'pkg-metered',
		kodyId: 'metered-package',
		sourceId: 'source-metered',
	}
	const emptyRegistry = {
		capabilityDomains: [],
		capabilityDomainDescriptionsByName: {} as Record<string, string>,
		capabilityHandlers: {},
		capabilityList: [],
		capabilityMap: {},
		capabilitySpecs: {},
		capabilityToolDescriptors: {},
	} as Awaited<ReturnType<typeof getCapabilityRegistryForContext>>
	const getRegistrySpy = vi
		.spyOn(
			await import('#mcp/capabilities/registry.ts'),
			'getCapabilityRegistryForContext',
		)
		.mockResolvedValue(emptyRegistry)
	const usageModule = await import('#worker/usage/record-usage.ts')
	const recordUsageSpy = vi
		.spyOn(usageModule, 'recordUsage')
		.mockResolvedValue(undefined)
	let executeResult: { result: unknown; error?: unknown; logs: Array<string> } =
		{
			result: 'ok',
			logs: [],
		}
	const createExecuteExecutorSpy = vi
		.spyOn(await import('#mcp/executor.ts'), 'createExecuteExecutor')
		.mockReturnValue({
			async execute() {
				return executeResult
			},
		} as never)

	try {
		const successResult = await runBundledModuleWithRegistry(
			env,
			callerContext,
			bundle,
			undefined,
			{
				packageContext,
				skipCapabilityRegistry: true,
			},
		)
		expect(successResult.result).toBe('ok')
		expect(createExecuteExecutorSpy).toHaveBeenCalledWith(
			expect.objectContaining({
				recordExecuteUsage: false,
			}),
		)
		expect(recordUsageSpy).toHaveBeenCalledTimes(1)
		expect(recordUsageSpy).toHaveBeenCalledWith(
			env,
			expect.objectContaining({
				userId: 'user-metered',
				eventType: 'package_export',
				entityId: 'pkg-metered',
				outcome: 'success',
				durationMs: expect.any(Number),
			}),
		)
		expect(
			recordUsageSpy.mock.calls[0]?.[1]?.durationMs,
		).toBeGreaterThanOrEqual(0)

		recordUsageSpy.mockClear()
		executeResult = {
			result: undefined,
			error: 'sandbox failed',
			logs: [],
		}
		const errorResult = await runBundledModuleWithRegistry(
			env,
			callerContext,
			bundle,
			undefined,
			{
				packageContext,
				skipCapabilityRegistry: true,
			},
		)
		expect(errorResult.error).toBe('sandbox failed')
		expect(recordUsageSpy).toHaveBeenCalledTimes(1)
		expect(recordUsageSpy).toHaveBeenCalledWith(
			env,
			expect.objectContaining({
				userId: 'user-metered',
				eventType: 'package_export',
				entityId: 'pkg-metered',
				outcome: 'error',
				durationMs: expect.any(Number),
			}),
		)

		recordUsageSpy.mockClear()
		executeResult = {
			result: 'ok',
			logs: [],
		}
		await runBundledModuleWithRegistry(env, callerContext, bundle, undefined, {
			skipCapabilityRegistry: true,
		})
		expect(recordUsageSpy).not.toHaveBeenCalled()

		recordUsageSpy.mockClear()
		const anonymousCallerContext = createMcpCallerContext({
			baseUrl: 'https://heykody.dev',
			user: null,
		})
		await runBundledModuleWithRegistry(
			env,
			anonymousCallerContext,
			bundle,
			undefined,
			{
				packageContext,
				skipCapabilityRegistry: true,
			},
		)
		expect(recordUsageSpy).not.toHaveBeenCalled()

		// Failures before the sandbox ever runs (executor construction, module
		// hydration, provider assembly) still count as failed package runs.
		recordUsageSpy.mockClear()
		createExecuteExecutorSpy.mockImplementation(() => {
			throw new Error('executor construction failed')
		})
		await expect(
			runBundledModuleWithRegistry(env, callerContext, bundle, undefined, {
				packageContext,
				skipCapabilityRegistry: true,
			}),
		).rejects.toThrow('executor construction failed')
		expect(recordUsageSpy).toHaveBeenCalledTimes(1)
		expect(recordUsageSpy).toHaveBeenCalledWith(
			env,
			expect.objectContaining({
				userId: 'user-metered',
				eventType: 'package_export',
				entityId: 'pkg-metered',
				outcome: 'error',
			}),
		)
	} finally {
		createExecuteExecutorSpy.mockRestore()
		getRegistrySpy.mockRestore()
		recordUsageSpy.mockRestore()
	}
})

test('runBundledModuleWithRegistry injects OAuth helper prelude only when execute helper capabilities are present', async () => {
	silenceIncidentalRuntimeWarnings()
	const env = {} as Env
	const callerContext = createMcpCallerContext({
		baseUrl: 'https://heykody.dev',
		user: { userId: 'user-123' },
	})
	const bundle = {
		mainModule: 'entry.js',
		modules: {
			'entry.js': 'export default async () => "ok"',
		},
	}
	const wrappedSources: Array<string> = []
	const createExecuteExecutorSpy = vi
		.spyOn(await import('#mcp/executor.ts'), 'createExecuteExecutor')
		.mockReturnValue({
			async execute(wrapped) {
				wrappedSources.push(String(wrapped))
				return {
					result: 'ok',
					logs: [],
				}
			},
		} as never)

	try {
		await expect(
			runBundledModuleWithRegistry(env, callerContext, bundle, undefined, {
				skipCapabilityRegistry: true,
			}),
		).resolves.toMatchObject({ result: 'ok' })
		await expect(
			runBundledModuleWithRegistry(env, callerContext, bundle, undefined, {
				skipCapabilityRegistry: true,
				additionalTools: {
					integration_get: async () => ({}),
					integration_token_refresh: async () => ({}),
					integration_refresh_access_token: async () => ({}),
					value_get: async () => ({}),
				},
			}),
		).resolves.toMatchObject({ result: 'ok' })

		const [withoutHelpers, withHelpers] = wrappedSources
		expect(withoutHelpers).toBeTruthy()
		expect(withHelpers).toBeTruthy()
		expect(withoutHelpers).not.toContain('__kodyRefreshAccessToken')
		expect(withHelpers).toContain('__kodyRefreshAccessToken')
		expect(withHelpers!.length).toBeGreaterThan(withoutHelpers!.length)
	} finally {
		createExecuteExecutorSpy.mockRestore()
	}
})

test('runBundledModuleWithRegistry rewrites guard-less unbound runtime helper errors with a bound-context hint', async () => {
	silenceIncidentalRuntimeWarnings()
	const env = {} as Env
	const callerContext = createMcpCallerContext({
		baseUrl: 'https://heykody.dev',
		user: { userId: 'user-123' },
	})
	// Mirrors a saved-package export imported statically into an ad hoc
	// execute call: the bundled module imports `storage` through the rewritten
	// virtual runtime path and calls it without a falsiness guard.
	const bundle = {
		mainModule: 'entry.js',
		modules: {
			'entry.js': `import { storage } from './.__kody_virtual__/runtime.js'

export default async function main() {
	const result = await storage.sql('select count(*) as count from items')
	return result.rows
}`,
		},
	}
	const bareTypeError = "Cannot read properties of undefined (reading 'sql')"
	const createExecuteExecutorSpy = vi
		.spyOn(await import('#mcp/executor.ts'), 'createExecuteExecutor')
		.mockReturnValue({
			async execute() {
				return {
					result: undefined,
					error: bareTypeError,
					logs: [],
				}
			},
		} as never)

	try {
		const unboundResult = await runBundledModuleWithRegistry(
			env,
			callerContext,
			bundle,
			undefined,
			{
				skipCapabilityRegistry: true,
			},
		)
		expect(unboundResult.error).toContain(bareTypeError)
		expect(
			mcpExecutor.getExecutionErrorDetails(unboundResult.error),
		).toMatchObject({
			kind: 'runtime_helper_unbound',
			helperName: 'storage',
			nextStep: expect.stringContaining('statically import'),
		})
		expect(
			mcpExecutor.getExecutionErrorDetails(unboundResult.error)?.nextStep,
		).not.toContain('packages.invokeChecked')

		// With storage bound, the same TypeError is an ordinary user-code bug
		// and keeps its bare message.
		const boundEnv = {
			STORAGE_RUNNER: {
				idFromName: () => 'storage-runner-id',
				get: () => ({}),
			},
		} as unknown as Env
		const boundResult = await runBundledModuleWithRegistry(
			boundEnv,
			callerContext,
			bundle,
			undefined,
			{
				skipCapabilityRegistry: true,
				storageTools: {
					userId: 'user-123',
					storageId: 'storage-1',
					writable: false,
				},
			},
		)
		expect(boundResult.error).toBe(bareTypeError)

		// Guard-less access inside a dynamically hydrated package module
		// (literal dynamic `import("kody:@...")` target) must be matched too:
		// the original bundle has no runtime import, only the hydrated module
		// graph the sandbox actually executed does.
		const hydrateSpy = vi
			.spyOn(
				await import('#worker/package-runtime/module-graph.ts'),
				'hydrateKodyRuntimeModules',
			)
			.mockResolvedValue({
				modules: {
					'entry.js': `export default async function main() {
	const mod = await import('kody:@scope/notes/note-list')
	return await mod.default({})
}`,
					'.__kody_dynamic__/scope/notes/note-list.js': `import { storage } from '../../.__kody_virtual__/runtime.js'
export default async () => (await storage.sql('select 1')).rows`,
				},
				dynamicDependencyPackageIds: [],
			})
		try {
			const hydratedResult = await runBundledModuleWithRegistry(
				env,
				callerContext,
				{
					mainModule: 'entry.js',
					modules: {
						'entry.js': `export default async function main() {
	const mod = await import('kody:@scope/notes/note-list')
	return await mod.default({})
}`,
					},
				},
				undefined,
				{
					skipCapabilityRegistry: true,
				},
			)
			expect(hydratedResult.error).toContain(
				'The optional kody:runtime export "storage" is not bound in this execution context',
			)
		} finally {
			hydrateSpy.mockRestore()
		}
	} finally {
		createExecuteExecutorSpy.mockRestore()
	}
})

test('runBundledModuleWithRegistry finishes execute run records on failure only', async () => {
	silenceIncidentalRuntimeWarnings()
	const env = {} as Env
	const callerContext = createMcpCallerContext({
		baseUrl: 'https://heykody.dev',
		user: {
			userId: 'user-execute-records',
			email: 'execute@example.com',
			displayName: 'Execute User',
		},
	})
	const bundle = {
		mainModule: 'entry.js',
		modules: {
			'entry.js': 'export default async () => "ok"',
		},
	}
	const handle = {
		id: 'run-execute-1',
		userId: 'user-execute-records',
		startedAt: '2026-07-26T00:00:00.000Z',
		persistence: 'on-failure' as const,
		context: {
			surface: 'execute' as const,
			name: null,
			storageId: 'storage-1',
			metadata: { conversationId: 'conv-1' },
		},
	}
	const runRecords = await import('#worker/run-records/service.ts')
	const beginSpy = vi
		.spyOn(runRecords, 'beginRunRecord')
		.mockReturnValue(handle)
	const persistedStatuses: Array<string> = []
	const finishSpy = vi
		.spyOn(runRecords, 'finishRunRecord')
		.mockImplementation(async (input) => {
			const current = input.handle
			if (!current) return
			if (current.persistence === 'on-failure' && input.status === 'success') {
				return
			}
			persistedStatuses.push(input.status)
		})
	let executeResult: { result: unknown; error?: unknown; logs: Array<string> } =
		{
			result: 'ok',
			logs: ['success log'],
		}
	const createExecuteExecutorSpy = vi
		.spyOn(await import('#mcp/executor.ts'), 'createExecuteExecutor')
		.mockReturnValue({
			async execute() {
				return executeResult
			},
		} as never)

	try {
		const success = await runBundledModuleWithRegistry(
			env,
			callerContext,
			bundle,
			undefined,
			{
				skipCapabilityRegistry: true,
				runRecord: {
					surface: 'execute',
					name: null,
					storageId: 'storage-1',
					metadata: { conversationId: 'conv-1' },
				},
			},
		)
		expect(success.error).toBeUndefined()
		expect(beginSpy).toHaveBeenCalledWith(
			expect.objectContaining({
				userId: 'user-execute-records',
				context: expect.objectContaining({
					surface: 'execute',
					storageId: 'storage-1',
				}),
			}),
		)
		expect(finishSpy).toHaveBeenCalledWith(
			expect.objectContaining({
				handle,
				status: 'success',
				logs: ['success log'],
			}),
		)
		expect(handle.context.metadata).toEqual(
			expect.objectContaining({
				conversationId: 'conv-1',
				sandboxMs: expect.any(Number),
			}),
		)
		expect(persistedStatuses).toEqual([])

		beginSpy.mockClear()
		finishSpy.mockClear()
		executeResult = {
			result: undefined,
			error: mcpExecutor.createExecutorSandboxTimeoutMessage(2_500),
			logs: ['failure log'],
		}
		const failure = await runBundledModuleWithRegistry(
			env,
			callerContext,
			bundle,
			undefined,
			{
				skipCapabilityRegistry: true,
				runRecord: {
					surface: 'execute',
					name: null,
					storageId: 'storage-1',
					metadata: { conversationId: 'conv-1' },
				},
			},
		)
		expect(failure.error).toBe(
			mcpExecutor.createExecutorSandboxTimeoutMessage(2_500),
		)
		expect(finishSpy).toHaveBeenCalledWith(
			expect.objectContaining({
				handle,
				status: 'error',
				logs: ['failure log'],
				error: expect.objectContaining({
					name: 'TimeoutError',
					message: mcpExecutor.createExecutorSandboxTimeoutMessage(2_500),
				}),
			}),
		)
		expect(persistedStatuses).toEqual(['error'])
	} finally {
		beginSpy.mockRestore()
		finishSpy.mockRestore()
		createExecuteExecutorSpy.mockRestore()
	}
})

test('runBundledModuleWithRegistry leaves claimed job transient failures running', async () => {
	silenceIncidentalRuntimeWarnings()
	const env = {} as Env
	const callerContext = createMcpCallerContext({
		baseUrl: 'https://heykody.dev',
		user: {
			userId: 'user-job-estimate',
			email: 'job-estimate@example.com',
			displayName: 'Job Estimate',
		},
	})
	const bundle = {
		mainModule: 'entry.js',
		modules: {
			'entry.js': 'export default async () => "ok"',
		},
	}
	const handle = {
		id: 'run-job-estimate-1',
		userId: 'user-job-estimate',
		startedAt: '2026-08-21T14:40:00.000Z',
		persistence: 'eager' as const,
		context: {
			surface: 'job' as const,
			name: 'sweep',
			jobId: 'package-job:estimate:sweep',
			metadata: {},
		},
	}
	const runRecords = await import('#worker/run-records/service.ts')
	const finishSpy = vi
		.spyOn(runRecords, 'finishRunRecord')
		.mockResolvedValue(true)
	const { createStorageEstimateReadError } =
		await import('#worker/storage-estimate-error.ts')
	const { d1NetworkConnectionLostMessage } = await import('#worker/d1-retry.ts')
	const estimateError = createStorageEstimateReadError({
		storageId: 'package:estimate-target',
		attempts: 4,
		cause: new Error('Storage estimate read timed out after 2000ms.'),
	})
	const transientErrors = [
		estimateError.message,
		`${d1NetworkConnectionLostMessage}.`,
		`D1_ERROR: ${d1NetworkConnectionLostMessage}.`,
	]
	let executeError: unknown = transientErrors[0]
	const createExecuteExecutorSpy = vi
		.spyOn(await import('#mcp/executor.ts'), 'createExecuteExecutor')
		.mockReturnValue({
			async execute() {
				if (executeError instanceof Error) {
					throw executeError
				}
				return {
					result: undefined,
					error: executeError,
					logs: [],
				}
			},
		} as never)
	const claimedJobOptions = {
		skipCapabilityRegistry: true,
		runRecord: {
			surface: 'job' as const,
			name: 'sweep',
			jobId: 'package-job:estimate:sweep',
		},
		runRecordHandle: handle,
	}

	try {
		for (const error of transientErrors) {
			executeError = error
			finishSpy.mockClear()
			const claimed = await runBundledModuleWithRegistry(
				env,
				callerContext,
				bundle,
				undefined,
				claimedJobOptions,
			)
			expect(claimed.error).toBe(error)
			expect(finishSpy).not.toHaveBeenCalled()
		}

		executeError = new Error(`${d1NetworkConnectionLostMessage}.`)
		finishSpy.mockClear()
		await expect(
			runBundledModuleWithRegistry(
				env,
				callerContext,
				bundle,
				undefined,
				claimedJobOptions,
			),
		).rejects.toThrow(`${d1NetworkConnectionLostMessage}.`)
		expect(finishSpy).not.toHaveBeenCalled()

		executeError = 'user code failed'
		finishSpy.mockClear()
		const userCode = await runBundledModuleWithRegistry(
			env,
			callerContext,
			bundle,
			undefined,
			claimedJobOptions,
		)
		expect(userCode.error).toBe('user code failed')
		expect(finishSpy).toHaveBeenCalledWith(
			expect.objectContaining({
				handle,
				status: 'error',
			}),
		)

		executeError = `${d1NetworkConnectionLostMessage}.`
		finishSpy.mockClear()
		const executeFailure = await runBundledModuleWithRegistry(
			env,
			callerContext,
			bundle,
			undefined,
			{
				skipCapabilityRegistry: true,
				runRecord: {
					surface: 'execute',
					name: null,
					storageId: 'storage-1',
				},
				runRecordHandle: {
					...handle,
					context: {
						surface: 'execute',
						name: null,
						storageId: 'storage-1',
						metadata: {},
					},
				},
			},
		)
		expect(executeFailure.error).toBe(`${d1NetworkConnectionLostMessage}.`)
		expect(finishSpy).toHaveBeenCalledWith(
			expect.objectContaining({
				status: 'error',
			}),
		)
	} finally {
		finishSpy.mockRestore()
		createExecuteExecutorSpy.mockRestore()
	}
})

test('runBundledModuleWithRegistry retries transient Durable Object isolate resets', async () => {
	silenceIncidentalRuntimeWarnings()
	const env = {} as Env
	const callerContext = createMcpCallerContext({
		baseUrl: 'https://heykody.dev',
		user: {
			userId: 'user-do-reset',
			email: 'reset@example.com',
			displayName: 'Reset User',
		},
	})
	const bundle = {
		mainModule: 'entry.js',
		modules: {
			'entry.js': 'export default async () => "ok"',
		},
	}
	const handle = {
		id: 'run-do-reset-1',
		userId: 'user-do-reset',
		startedAt: '2026-08-18T00:00:00.000Z',
		persistence: 'on-failure' as const,
		context: {
			surface: 'export' as const,
			name: './scan',
			metadata: {},
		},
	}
	const runRecords = await import('#worker/run-records/service.ts')
	const beginSpy = vi
		.spyOn(runRecords, 'beginRunRecord')
		.mockReturnValue(handle)
	const finishSpy = vi
		.spyOn(runRecords, 'finishRunRecord')
		.mockResolvedValue(undefined)
	const cleanHostSideEffects = {
		dispatcherAttempts: 0,
		fetchAttempts: 0,
	}
	const execute = vi
		.fn()
		.mockResolvedValueOnce({
			result: undefined,
			error: 'Durable Object reset because its code was updated.',
			logs: [],
			hostMediatedSideEffects: cleanHostSideEffects,
		})
		.mockResolvedValueOnce({
			result: { scanned: 2 },
			logs: ['recovered'],
			hostMediatedSideEffects: cleanHostSideEffects,
		})
	const createExecuteExecutorSpy = vi
		.spyOn(mcpExecutor, 'createExecuteExecutor')
		.mockReturnValue({
			execute,
		} as never)
	const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {})

	try {
		vi.useFakeTimers()
		const recoveredPending = runBundledModuleWithRegistry(
			env,
			callerContext,
			bundle,
			undefined,
			{
				skipCapabilityRegistry: true,
				runRecord: {
					surface: 'export',
					name: './scan',
				},
			},
		)
		await vi.runAllTimersAsync()
		const recovered = await recoveredPending
		expect(recovered.error).toBeUndefined()
		expect(recovered.result).toEqual({ scanned: 2 })
		expect(execute).toHaveBeenCalledTimes(2)
		expect(finishSpy).toHaveBeenCalledTimes(1)
		expect(finishSpy).toHaveBeenCalledWith(
			expect.objectContaining({
				handle,
				status: 'success',
				result: { scanned: 2 },
			}),
		)
		expect(consoleWarn).toHaveBeenCalledWith(
			expect.stringContaining(
				'runBundledModuleWithRegistry transient Durable Object reset',
			),
		)

		execute.mockReset()
		finishSpy.mockClear()
		consoleWarn.mockClear()
		execute.mockResolvedValue({
			result: undefined,
			error: 'Durable Object reset because its code was updated.',
			logs: [],
			hostMediatedSideEffects: cleanHostSideEffects,
		})
		const exhaustedPending = runBundledModuleWithRegistry(
			env,
			callerContext,
			bundle,
			undefined,
			{
				skipCapabilityRegistry: true,
				runRecord: {
					surface: 'export',
					name: './scan',
				},
			},
		)
		await vi.runAllTimersAsync()
		const exhausted = await exhaustedPending
		expect(exhausted.error).toBe(
			'Durable Object reset because its code was updated.',
		)
		expect(execute).toHaveBeenCalledTimes(4)
		expect(finishSpy).toHaveBeenCalledWith(
			expect.objectContaining({
				status: 'error',
				error: expect.objectContaining({
					message: 'Durable Object reset because its code was updated.',
				}),
			}),
		)

		execute.mockReset()
		finishSpy.mockClear()
		consoleWarn.mockClear()
		execute.mockResolvedValue({
			result: undefined,
			error: 'Durable Object reset because its code was updated.',
			logs: [],
			hostMediatedSideEffects: {
				dispatcherAttempts: 1,
				fetchAttempts: 0,
			},
		})
		const dirty = await runBundledModuleWithRegistry(
			env,
			callerContext,
			bundle,
			undefined,
			{
				skipCapabilityRegistry: true,
				runRecord: {
					surface: 'export',
					name: './scan',
				},
			},
		)
		expect(dirty.error).toBe(
			'Durable Object reset because its code was updated.',
		)
		expect(execute).toHaveBeenCalledTimes(1)
		expect(consoleWarn).not.toHaveBeenCalledWith(
			expect.stringContaining(
				'runBundledModuleWithRegistry transient Durable Object reset',
			),
		)
	} finally {
		vi.useRealTimers()
		consoleWarn.mockRestore()
		beginSpy.mockRestore()
		finishSpy.mockRestore()
		createExecuteExecutorSpy.mockRestore()
	}
})

test('runBundledModuleWithRegistry schedules finish via waitUntil when provided', async () => {
	silenceIncidentalRuntimeWarnings()
	const env = {} as Env
	const callerContext = createMcpCallerContext({
		baseUrl: 'https://heykody.dev',
		user: {
			userId: 'user-wait-until',
			email: 'wait@example.com',
			displayName: 'Wait User',
		},
	})
	const bundle = {
		mainModule: 'entry.js',
		modules: {
			'entry.js': 'export default async () => "ok"',
		},
	}
	const handle = {
		id: 'run-wait-until-1',
		userId: 'user-wait-until',
		startedAt: '2026-07-26T00:00:00.000Z',
		persistence: 'eager' as const,
		context: {
			surface: 'subscription' as const,
			name: 'email.message.received',
		},
	}
	const runRecords = await import('#worker/run-records/service.ts')
	const beginSpy = vi
		.spyOn(runRecords, 'beginRunRecord')
		.mockReturnValue(handle)
	let resolveFinish: (() => void) | undefined
	const finishGate = new Promise<void>((resolve) => {
		resolveFinish = resolve
	})
	const finishSpy = vi
		.spyOn(runRecords, 'finishRunRecord')
		.mockImplementation(async (input) => {
			if (input.waitUntil) {
				input.waitUntil(
					(async () => {
						await finishGate
					})(),
				)
				return
			}
			await finishGate
		})
	const createExecuteExecutorSpy = vi
		.spyOn(await import('#mcp/executor.ts'), 'createExecuteExecutor')
		.mockReturnValue({
			async execute() {
				return { result: 'ok', logs: [] }
			},
		} as never)
	const waitUntilTasks: Array<Promise<unknown>> = []

	try {
		const resultPromise = runBundledModuleWithRegistry(
			env,
			callerContext,
			bundle,
			undefined,
			{
				skipCapabilityRegistry: true,
				runRecord: {
					surface: 'subscription',
					name: 'email.message.received',
				},
				waitUntil: (promise) => {
					waitUntilTasks.push(promise)
				},
			},
		)
		const result = await resultPromise
		expect(result.error).toBeUndefined()
		expect(finishSpy).toHaveBeenCalledWith(
			expect.objectContaining({
				handle,
				status: 'success',
				waitUntil: expect.any(Function),
			}),
		)
		expect(waitUntilTasks).toHaveLength(1)
		resolveFinish?.()
		await Promise.all(waitUntilTasks)
	} finally {
		beginSpy.mockRestore()
		finishSpy.mockRestore()
		createExecuteExecutorSpy.mockRestore()
	}
})
