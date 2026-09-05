import { expect, test, vi } from 'vitest'
import { silenceIncidentalRuntimeWarnings } from '#worker/test-support/incidental-runtime-warnings.ts'
import { type getCapabilityRegistryForContext } from '#mcp/capabilities/registry.ts'
import { buildCapabilityRegistry } from '#mcp/capabilities/build-capability-registry.ts'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { createMcpCallerContext } from '#mcp/context.ts'
import { buildKodyModuleBundle } from '#worker/package-runtime/module-graph.ts'
import type * as ModuleGraph from '#worker/package-runtime/module-graph.ts'
import {
	buildKodyFns,
	createWorkflowTools,
	runModuleWithRegistry,
} from './run-kody-registry.ts'
import * as mcpExecutor from '#mcp/executor.ts'
import { PackageSecretMountError } from '#mcp/secrets/package-access.ts'
import * as packageAccess from '#mcp/secrets/package-access.ts'
import {
	type JobRecord,
	type PersistedJobCallerContext,
} from '#worker/jobs/types.ts'
import {
	insertRepoSession,
	listRepoSessionsBySource,
} from '#worker/repo/repo-sessions.ts'
import { createD1JobsStore } from '@kody-internal/shared/jobs/store.ts'
import {
	createFakeRunLogNamespace,
	createJobMutationDatabase,
	createJobMutationKv,
	createRunKodyRegistryTestEnv,
	createJobRow,
	createEntitySourceRow,
	createRepoSessionRow,
} from '#worker/test-support/run-kody-registry.ts'

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
test('buildKodyFns rejects role-gated capabilities even when passed an unfiltered registry', async () => {
	// The stub Env has no MCP server storage, so metadata loading warns
	// 'mcp-server-refs-load-failed' before degrading to "no MCP servers".
	silenceIncidentalRuntimeWarnings()
	const adminOnlyCapability = defineDomainCapability('admin', {
		name: 'adminUserList',
		description: 'List admin user account metadata',
		readOnly: true,
		idempotent: true,
		requiredRole: 'admin',
		inputSchema: {
			type: 'object',
			properties: {},
		},
		handler: async () => ({ ok: true }),
	})
	const registry = buildCapabilityRegistry([
		{
			name: 'admin',
			description: 'Admin capabilities',
			capabilities: [adminOnlyCapability],
		},
	])
	const tools = await buildKodyFns(
		{} as Env,
		createMcpCallerContext({
			baseUrl: 'https://example.com',
			user: {
				userId: 'user-1',
				email: 'user@example.com',
				displayName: 'user',
				roles: ['user'],
			},
		}),
		{ capabilityRegistry: registry },
	)

	await expect(tools.adminUserList({})).rejects.toThrow(
		'MCP user lacks required role "admin" for capability "adminUserList".',
	)
})

test('package workflow tools create instances from package context and honor caller overrides in runModuleWithRegistry', async () => {
	silenceIncidentalRuntimeWarnings()
	const created: Array<WorkflowInstanceCreateOptions<unknown>> = []
	const runLog = createFakeRunLogNamespace()
	const workflowTools = createWorkflowTools({
		env: {
			APP_DB: {
				prepare(query: string) {
					return {
						bind() {
							return {
								async first() {
									if (query.includes('COUNT(*) AS count')) return { count: 0 }
									if (query.includes('FROM saved_packages')) {
										return {
											id: 'pkg-1',
											user_id: 'user-1',
											name: 'Shade automation',
											kody_id: 'shade-automation',
											description: 'Shade automation package',
											tags_json: '[]',
											search_text: null,
											source_id: 'source-1',
											has_app: 0,
											created_at: '2026-05-03T00:00:00.000Z',
											updated_at: '2026-05-03T00:00:00.000Z',
										}
									}
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
			providerFns?.packageWorkflowCreate({ workflowName: 'custom' }),
		).resolves.toEqual({ ok: true, id: 'custom-workflow' })
		expect(customWorkflowTools.create).toHaveBeenCalledWith({
			workflowName: 'custom',
		})
	} finally {
		createExecuteExecutorSpy.mockRestore()
	}
})

test('runModuleWithRegistry queues inline workflows.create calls without runAt or idempotencyKey', async () => {
	silenceIncidentalRuntimeWarnings()
	const created: Array<WorkflowInstanceCreateOptions<unknown>> = []
	const runLog = createFakeRunLogNamespace()
	const env = {
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
	const callerContext = createMcpCallerContext({
		baseUrl: 'https://app.example.com',
		user: {
			userId: 'user-1',
			email: 'me@example.com',
			displayName: 'Me',
		},
		storageContext: null,
	})
	let wrappedSource = ''
	const createExecuteExecutorSpy = vi
		.spyOn(mcpExecutor, 'createExecuteExecutor')
		.mockReturnValue({
			async execute(_wrapped, providers) {
				wrappedSource = String(_wrapped)
				const provider = providers[0] as {
					fns: Record<string, (args: unknown) => Promise<unknown>>
				}
				return {
					result: await provider.fns.packageWorkflowCreate({
						code: 'export default async function main() { return { ok: true } }',
					}),
					logs: [],
				}
			},
		} as never)

	try {
		vi.useFakeTimers()
		vi.setSystemTime(new Date('2026-05-03T12:34:56.000Z'))
		const result = await runModuleWithRegistry(
			env,
			callerContext,
			`import { workflows } from 'kody:runtime'
export default async function main() {
  return await workflows.create({ code: \`export default async function main() { return { ok: true } }\` })
}`,
		)

		expect(result.result).toMatchObject({
			ok: true,
			source_type: 'inline',
			workflow_name: 'inline-code',
			export_name: null,
			run_at: '2026-05-03T12:34:56.000Z',
			plan_date: '2026-05-03',
			status: 'queued',
		})
		expect(wrappedSource).toContain('const workflows = {')
		expect(wrappedSource).toContain('kody.packageWorkflowCreate')
		expect(created).toHaveLength(1)
		expect(created[0]?.params).toEqual(
			expect.objectContaining({
				sourceType: 'inline',
				userId: 'user-1',
				workflowName: 'inline-code',
				code: 'export default async function main() { return { ok: true } }',
				idempotencyKey: expect.stringMatching(/^generated:/),
				runAt: '2026-05-03T12:34:56.000Z',
				planDate: '2026-05-03',
			}),
		)
	} finally {
		vi.useRealTimers()
		createExecuteExecutorSpy.mockRestore()
	}
})

test('buildKodyFns updates and deletes jobs through production-shaped bindings', async () => {
	// Deleting the job also best-effort deletes its artifact repo, which fails
	// against this test's stub fetch and logs a JSON warning.
	silenceIncidentalRuntimeWarnings([
		/^\{"message":"artifact repo delete failed"/,
	])
	const callerContext = createMcpCallerContext({
		baseUrl: 'https://heykody.dev',
		user: {
			userId: 'user-123',
			email: 'user@example.com',
			displayName: 'User Example',
		},
		storageContext: {
			sessionId: null,
			appId: 'app-123',
			storageId: null,
		},
	}) as PersistedJobCallerContext
	const job: JobRecord = {
		version: 1,
		id: '504513c3-f29e-47f0-9ea1-402569ebef54',
		userId: callerContext.user.userId,
		name: 'hrv-discord-reaction-poller',
		sourceId: 'job-source-1',
		publishedCommit: 'published-commit-1',
		storageId: `job:504513c3-f29e-47f0-9ea1-402569ebef54`,
		params: {
			channelId: 'discord-channel-1',
		},
		schedule: {
			type: 'interval',
			every: '5m',
		},
		timezone: 'UTC',
		enabled: true,
		killSwitchEnabled: false,
		preserved: false,
		expiresAt: null,
		createdAt: '2026-04-16T00:00:00.000Z',
		updatedAt: '2026-04-16T00:00:00.000Z',
		nextRunAt: '2026-04-16T00:05:00.000Z',
		runCount: 0,
		successCount: 0,
		errorCount: 0,
	}
	const db = createJobMutationDatabase({
		jobs: [createJobRow(job, callerContext)],
		entitySources: [
			createEntitySourceRow({
				userId: callerContext.user.userId,
				jobId: job.id,
				sourceId: job.sourceId,
				repoId: `job-${job.id}`,
			}),
		],
	})
	const kv = createJobMutationKv()
	const repoSessionAccesses: Array<string> = []
	const jobManagerSyncPayloads: Array<{ userId: string; source?: string }> = []
	const env = createRunKodyRegistryTestEnv({
		APP_DB: db,
		SENTRY_ENVIRONMENT: 'production',
		CLOUDFLARE_ACCOUNT_ID: 'acct-test',
		CLOUDFLARE_API_TOKEN: 'token-test',
		CLOUDFLARE_API_BASE_URL: 'https://api.cloudflare.test',
		BUNDLE_ARTIFACTS_KV: kv,
		REPO_SESSION: {
			idFromName(name: string) {
				repoSessionAccesses.push(name)
				throw new Error('metadata-only job updates must not publish source')
			},
			get() {
				throw new Error('metadata-only job updates must not open repo sessions')
			},
		},
		JOBS: {
			...createD1JobsStore(db),
			async syncAlarm(input: { userId: string }) {
				if (input.userId !== callerContext.user.userId) {
					throw new Error(
						`Expected JOBS.syncAlarm to be scoped to ${callerContext.user.userId}`,
					)
				}
				jobManagerSyncPayloads.push(input)
				return {
					ok: true as const,
					userId: input.userId,
					nextRunAt: null,
				}
			},
		},
		STORAGE_RUNNER: {
			idFromName(name: string) {
				return name as unknown as DurableObjectId
			},
			get() {
				return {
					clearStorage: async () => ({ ok: true as const }),
				}
			},
		},
	})
	await insertRepoSession(
		env,
		createRepoSessionRow({
			id: 'session-1',
			userId: callerContext.user.userId,
			sourceId: job.sourceId,
			sourceRepoId: `job-${job.id}-session`,
		}),
	)
	const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
		new Response(
			JSON.stringify({
				success: true,
				result: { id: 'artifact-repo-1' },
				errors: [],
				messages: [],
			}),
			{ status: 200 },
		),
	)

	try {
		const kody = await buildKodyFns(env, callerContext)
		await expect(
			kody.jobUpdate({
				id: job.id,
				enabled: false,
			}),
		).resolves.toMatchObject({
			job_id: job.id,
			name: 'hrv-discord-reaction-poller',
			enabled: false,
			params: {
				channelId: 'discord-channel-1',
			},
		})
		expect(repoSessionAccesses).toEqual([])
		expect(jobManagerSyncPayloads).toMatchObject([
			{ userId: callerContext.user.userId },
		])
		await expect(
			db
				.prepare('SELECT * FROM jobs WHERE id = ? AND user_id = ?')
				.bind(job.id, callerContext.user.userId)
				.first<Record<string, unknown>>(),
		).resolves.toMatchObject({
			enabled: 0,
		})

		await expect(kody.jobDelete({ id: job.id })).resolves.toEqual({
			job_id: job.id,
			deleted: true,
		})
		expect(repoSessionAccesses).toEqual([])
		expect(jobManagerSyncPayloads).toMatchObject([
			{ userId: callerContext.user.userId },
			{ userId: callerContext.user.userId },
		])
		await expect(
			db
				.prepare('SELECT * FROM jobs WHERE id = ? AND user_id = ?')
				.bind(job.id, callerContext.user.userId)
				.first<Record<string, unknown>>(),
		).resolves.toBeNull()
		await expect(
			listRepoSessionsBySource(env, {
				userId: callerContext.user.userId,
				sourceId: job.sourceId,
			}),
		).resolves.toEqual([])
	} finally {
		fetchSpy.mockRestore()
	}
})

test('buildKodyFns tracks secretSet values for execute redaction', async () => {
	silenceIncidentalRuntimeWarnings()
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
					name: 'secretSet',
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
							value: { type: 'string' },
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
				secretSet: {
					name: 'secretSet',
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
							value: { type: 'string' },
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
				secretSet: {
					description: 'Store a secret.',
					inputSchema: {
						type: 'object',
						properties: {
							name: { type: 'string' },
							value: { type: 'string' },
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
		const trackedKody = await buildKodyFns(
			{} as Env,
			createMcpCallerContext({
				baseUrl: 'https://heykody.dev',
				user: { userId: 'user-123' },
			}),
			{
				trackSecretInputValue(value) {
					trackedSecretValues.push(value)
				},
			},
		)
		const result = await trackedKody.secretSet({
			name: 'spotifyAccessToken',
			value: 'fresh-access-token',
		})
		expect(result).toEqual({ name: 'spotifyAccessToken' })
		expect(trackedSecretValues).toEqual(['fresh-access-token'])
	} finally {
		getRegistrySpy.mockRestore()
	}
})

test('buildKodyFns rejects package storage kody tools that collide with capabilities', async () => {
	silenceIncidentalRuntimeWarnings()
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
					name: 'packageStorageGet',
					domain: 'storage',
					description:
						'Capability that collides with a package storage helper.',
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
				packageStorageGet: {
					name: 'packageStorageGet',
					domain: 'storage',
					description:
						'Capability that collides with a package storage helper.',
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
				packageStorageGet: {
					description:
						'Capability that collides with a package storage helper.',
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
			buildKodyFns(env, callerContext, {
				packageStorageTools: {
					grantedPackageIds: new Set(['pkg-1']),
				},
			}),
		).rejects.toThrow(
			'Kody helper "packageStorageGet" collides with a capability.',
		)
	} finally {
		getRegistrySpy.mockRestore()
	}
})

test('runModuleWithRegistry redacts secret keys and survives cyclic results', async () => {
	silenceIncidentalRuntimeWarnings()
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
					name: 'secretSet',
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
							value: { type: 'string' },
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
				secretSet: {
					name: 'secretSet',
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
							value: { type: 'string' },
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
				secretSet: {
					description: 'Store a secret.',
					inputSchema: {
						type: 'object',
						properties: {
							name: { type: 'string' },
							value: { type: 'string' },
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
				await provider.fns.secretSet({
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
	const code = `import { kody } from 'kody:runtime'

export default async function run() {
	await kody.secretSet({
		name: 'spotifyAccessToken',
		value: 'fresh-access-token',
	})
	return null
}`

	try {
		const result = await runModuleWithRegistry(env, callerContext, code)
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

test('runModuleWithRegistry forwards package context', async () => {
	silenceIncidentalRuntimeWarnings()
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
		const result = await runModuleWithRegistry(
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
			providerFns?.packageSecretHas({ alias: 'token' }),
		).resolves.toEqual({
			has: true,
		})
		await expect(
			providerFns?.packageSecretHas({ alias: 'missing-token' }),
		).resolves.toEqual({
			has: false,
		})
		await expect(
			providerFns?.packageSecretGet({ alias: 'token' }),
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

test('runModuleWithRegistry records execute interpretable class only on execute-surface runs', async () => {
	silenceIncidentalRuntimeWarnings()
	const executeInterpretable = await import('#mcp/execute-interpretable.ts')
	const recordSpy = vi
		.spyOn(executeInterpretable, 'recordExecuteInterpretableEvent')
		.mockImplementation(() => {})
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
	const getRegistrySpy = vi
		.spyOn(
			await import('#mcp/capabilities/registry.ts'),
			'getCapabilityRegistryForContext',
		)
		.mockResolvedValue({
			capabilityHandlers: {},
			capabilityMap: {},
			toolSets: {},
			capabilityPreludes: {},
		} as never)
	const createExecuteExecutorSpy = vi
		.spyOn(mcpExecutor, 'createExecuteExecutor')
		.mockReturnValue({
			async execute() {
				return { result: 'ok', logs: [] }
			},
		} as never)

	try {
		const glueCode = `import { kody } from 'kody:runtime'
export default async function main() { return await kody.capability_id({}) }`
		await runModuleWithRegistry(env, callerContext, glueCode)
		expect(recordSpy).toHaveBeenCalledExactlyOnceWith(env, { source: glueCode })

		recordSpy.mockClear()
		const packageCode = `import whatShipped from 'kody:@you/bot/whatShipped'
export default async function main() { return await whatShipped({}) }`
		await runModuleWithRegistry(env, callerContext, packageCode, undefined, {
			packageContext: { packageId: 'pkg-1', kodyId: 'bot' },
		})
		expect(recordSpy).not.toHaveBeenCalled()
	} finally {
		createExecuteExecutorSpy.mockRestore()
		getRegistrySpy.mockRestore()
		recordSpy.mockRestore()
	}
})
