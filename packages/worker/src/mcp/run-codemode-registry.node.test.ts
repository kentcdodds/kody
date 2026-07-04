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
	type JobRecord,
	type PersistedJobCallerContext,
} from '#worker/jobs/types.ts'
import { type EntitySourceRow } from '#worker/repo/types.ts'

test('package workflow tools create instances from package context and honor caller overrides in runModuleWithRegistry', async () => {
	const created: Array<WorkflowInstanceCreateOptions<unknown>> = []
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
								async run() {
									return { success: true }
								},
							}
						},
					}
				},
			} as unknown as D1Database,
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
			providerFns?.package_workflow_create({ workflowName: 'custom' }),
		).resolves.toEqual({ ok: true, id: 'custom-workflow' })
		expect(customWorkflowTools.create).toHaveBeenCalledWith({
			workflowName: 'custom',
		})
	} finally {
		createExecuteExecutorSpy.mockRestore()
	}
})

vi.mock('#worker/package-runtime/module-graph.ts', async () => {
	const actual = await vi.importActual<
		typeof import('#worker/package-runtime/module-graph.ts')
	>('#worker/package-runtime/module-graph.ts')
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

function createJobMutationDatabase(input: {
	jobs: Array<Record<string, unknown>>
	entitySources: Array<Record<string, unknown>>
	repoSessions?: Array<Record<string, unknown>>
	publishedBundleArtifacts?: Array<Record<string, unknown>>
}) {
	const tables = new Map<string, Array<Record<string, unknown>>>([
		['jobs', structuredClone(input.jobs)],
		['entity_sources', structuredClone(input.entitySources)],
		['repo_sessions', structuredClone(input.repoSessions ?? [])],
		[
			'published_bundle_artifacts',
			structuredClone(input.publishedBundleArtifacts ?? []),
		],
	])

	const clone = <T>(value: T): T => structuredClone(value)
	const table = (name: string) => {
		const rows = tables.get(name)
		if (!rows) throw new Error(`Unknown test table: ${name}`)
		return rows
	}
	const selectOne = (
		name: string,
		predicate: (row: Record<string, unknown>) => boolean,
	) => clone(table(name).find(predicate) ?? null)
	const selectAll = (
		name: string,
		predicate: (row: Record<string, unknown>) => boolean,
	) => clone(table(name).filter(predicate))
	const deleteWhere = (
		name: string,
		predicate: (row: Record<string, unknown>) => boolean,
	) => {
		const rows = table(name)
		const remaining = rows.filter((row) => !predicate(row))
		tables.set(name, remaining)
		return rows.length - remaining.length
	}

	return {
		prepare(query: string) {
			const normalized = query.replace(/\s+/g, ' ').trim()
			return {
				bind(...params: Array<unknown>) {
					return {
						async first<T = Record<string, unknown>>() {
							if (
								normalized === 'SELECT * FROM jobs WHERE id = ? AND user_id = ?'
							) {
								return selectOne(
									'jobs',
									(row) =>
										row['id'] === params[0] && row['user_id'] === params[1],
								) as T | null
							}
							if (
								normalized ===
								'SELECT * FROM entity_sources WHERE id = ? AND user_id = ?'
							) {
								return selectOne(
									'entity_sources',
									(row) =>
										row['id'] === params[0] && row['user_id'] === params[1],
								) as T | null
							}
							throw new Error(`Unsupported first query: ${query}`)
						},
						async all<T = Record<string, unknown>>() {
							if (
								normalized ===
								'SELECT * FROM repo_sessions WHERE user_id = ? AND source_id = ? ORDER BY updated_at DESC'
							) {
								return {
									results: selectAll(
										'repo_sessions',
										(row) =>
											row['user_id'] === params[0] &&
											row['source_id'] === params[1],
									) as T[],
								}
							}
							if (
								normalized ===
								'SELECT * FROM published_bundle_artifacts WHERE user_id = ? AND source_id = ? ORDER BY updated_at DESC, created_at DESC'
							) {
								return {
									results: selectAll(
										'published_bundle_artifacts',
										(row) =>
											row['user_id'] === params[0] &&
											row['source_id'] === params[1],
									) as T[],
								}
							}
							throw new Error(`Unsupported all query: ${query}`)
						},
						async run() {
							if (normalized.startsWith('UPDATE jobs SET')) {
								const id = params[21]
								const userId = params[22]
								const existing = selectOne(
									'jobs',
									(row) => row['id'] === id && row['user_id'] === userId,
								)
								if (!existing) return { meta: { changes: 0, last_row_id: 0 } }
								const updated = {
									...existing,
									name: params[0],
									source_id: params[1],
									published_commit: params[2],
									repo_check_policy_json: params[3],
									storage_id: params[4],
									params_json: params[5],
									schedule_json: params[6],
									timezone: params[7],
									enabled: params[8],
									kill_switch_enabled: params[9],
									caller_context_json: params[10],
									updated_at: params[11],
									last_run_at: params[12],
									last_run_status: params[13],
									last_run_error: params[14],
									last_duration_ms: params[15],
									next_run_at: params[16],
									run_count: params[17],
									success_count: params[18],
									error_count: params[19],
									run_history_json: params[20],
								}
								const rows = table('jobs')
								const index = rows.findIndex(
									(row) => row['id'] === id && row['user_id'] === userId,
								)
								rows[index] = updated
								return { meta: { changes: 1, last_row_id: 0 } }
							}
							if (
								normalized === 'DELETE FROM jobs WHERE id = ? AND user_id = ?'
							) {
								return {
									meta: {
										changes: deleteWhere(
											'jobs',
											(row) =>
												row['id'] === params[0] && row['user_id'] === params[1],
										),
										last_row_id: 0,
									},
								}
							}
							if (
								normalized ===
								'DELETE FROM published_bundle_artifacts WHERE user_id = ? AND source_id = ?'
							) {
								return {
									meta: {
										changes: deleteWhere(
											'published_bundle_artifacts',
											(row) =>
												row['user_id'] === params[0] &&
												row['source_id'] === params[1],
										),
										last_row_id: 0,
									},
								}
							}
							if (
								normalized ===
								'DELETE FROM repo_sessions WHERE user_id = ? AND source_id = ?'
							) {
								return {
									meta: {
										changes: deleteWhere(
											'repo_sessions',
											(row) =>
												row['user_id'] === params[0] &&
												row['source_id'] === params[1],
										),
										last_row_id: 0,
									},
								}
							}
							if (
								normalized ===
								'DELETE FROM entity_sources WHERE id = ? AND user_id = ?'
							) {
								return {
									meta: {
										changes: deleteWhere(
											'entity_sources',
											(row) =>
												row['id'] === params[0] && row['user_id'] === params[1],
										),
										last_row_id: 0,
									},
								}
							}
							throw new Error(`Unsupported run query: ${query}`)
						},
					}
				},
			}
		},
	} as D1Database
}

function createJobMutationKv() {
	const deletedKeys: Array<string> = []
	return {
		deletedKeys,
		async get() {
			return null
		},
		async put() {},
		async delete(key: string) {
			deletedKeys.push(key)
		},
	} as unknown as KVNamespace & { deletedKeys: Array<string> }
}

function createJobRow(
	job: JobRecord,
	callerContext: PersistedJobCallerContext,
) {
	return {
		id: job.id,
		user_id: job.userId,
		name: job.name,
		source_id: job.sourceId,
		published_commit: job.publishedCommit,
		repo_check_policy_json: job.repoCheckPolicy
			? JSON.stringify(job.repoCheckPolicy)
			: null,
		storage_id: job.storageId,
		params_json: job.params ? JSON.stringify(job.params) : null,
		schedule_json: JSON.stringify(job.schedule),
		timezone: job.timezone,
		enabled: job.enabled ? 1 : 0,
		kill_switch_enabled: job.killSwitchEnabled ? 1 : 0,
		caller_context_json: JSON.stringify(callerContext),
		created_at: job.createdAt,
		updated_at: job.updatedAt,
		last_run_at: job.lastRunAt ?? null,
		last_run_status: job.lastRunStatus ?? null,
		last_run_error: job.lastRunError ?? null,
		last_duration_ms: job.lastDurationMs ?? null,
		next_run_at: job.nextRunAt,
		run_count: job.runCount,
		success_count: job.successCount,
		error_count: job.errorCount,
		run_history_json: JSON.stringify(job.runHistory),
	}
}

function createEntitySourceRow(input: {
	userId: string
	jobId: string
	sourceId: string
	repoId: string
}): EntitySourceRow {
	return {
		id: input.sourceId,
		user_id: input.userId,
		entity_kind: 'job',
		entity_id: input.jobId,
		repo_id: input.repoId,
		published_commit: 'published-commit-1',
		indexed_commit: null,
		manifest_path: 'kody.json',
		source_root: '/',
		last_external_check_at: null,
		created_at: '2026-04-16T00:00:00.000Z',
		updated_at: '2026-04-16T00:00:00.000Z',
	}
}

function createRepoSessionRow(input: {
	id: string
	userId: string
	sourceId: string
	sourceRepoId: string
}) {
	return {
		id: input.id,
		user_id: input.userId,
		source_id: input.sourceId,
		source_repo_id: input.sourceRepoId,
		session_branch: `sessions/${input.id}`,
		source_branch: 'main',
		base_commit: 'published-commit-1',
		source_root: '/',
		conversation_id: null,
		status: 'active',
		expires_at: null,
		last_checkpoint_at: null,
		last_checkpoint_commit: null,
		last_check_run_id: null,
		last_check_tree_hash: null,
		created_at: '2026-04-16T00:00:00.000Z',
		updated_at: '2026-04-16T00:00:00.000Z',
	}
}

test('buildCodemodeFns updates and deletes jobs through production-shaped bindings', async () => {
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
		createdAt: '2026-04-16T00:00:00.000Z',
		updatedAt: '2026-04-16T00:00:00.000Z',
		nextRunAt: '2026-04-16T00:05:00.000Z',
		runCount: 0,
		successCount: 0,
		errorCount: 0,
		runHistory: [],
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
		repoSessions: [
			createRepoSessionRow({
				id: 'session-1',
				userId: callerContext.user.userId,
				sourceId: job.sourceId,
				sourceRepoId: `job-${job.id}-session`,
			}),
		],
	})
	const kv = createJobMutationKv()
	const repoSessionAccesses: Array<string> = []
	const jobManagerNames: Array<string> = []
	const jobManagerSyncPayloads: Array<{ userId: string; source?: string }> = []
	const env = {
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
		JOB_MANAGER: {
			idFromName(name: string) {
				jobManagerNames.push(name)
				if (name !== callerContext.user.userId) {
					throw new Error(
						`Expected JOB_MANAGER to be scoped to ${callerContext.user.userId}`,
					)
				}
				return name as unknown as DurableObjectId
			},
			get() {
				return {
					async syncAlarm(input: { userId: string }) {
						jobManagerSyncPayloads.push(input)
						return {
							ok: true as const,
							userId: input.userId,
							nextRunAt: null,
						}
					},
				}
			},
		},
	} as unknown as Env
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
		const codemode = await buildCodemodeFns(env, callerContext)
		await expect(
			codemode.job_update({
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
		expect(jobManagerNames).toEqual([callerContext.user.userId])
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

		await expect(codemode.job_delete({ id: job.id })).resolves.toEqual({
			job_id: job.id,
			deleted: true,
		})
		expect(repoSessionAccesses).toEqual([])
		expect(jobManagerNames).toEqual([
			callerContext.user.userId,
			callerContext.user.userId,
		])
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
			db
				.prepare(
					'SELECT * FROM repo_sessions WHERE user_id = ? AND source_id = ? ORDER BY updated_at DESC',
				)
				.bind(callerContext.user.userId, job.sourceId)
				.all<Record<string, unknown>>(),
		).resolves.toEqual({ results: [] })
	} finally {
		fetchSpy.mockRestore()
	}
})

test('buildCodemodeFns resolves, denies, and tracks secret-marked capability inputs', async () => {
	let toolArguments: Record<string, unknown> | null = null
	const connectorEnv = {
		REMOTE_CONNECTOR_SESSION: {
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
					async rpcCallTool(_name: string, args: Record<string, unknown>) {
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

	const resolvedCodemode = await buildCodemodeFns(
		connectorEnv,
		createMcpCallerContext({
			baseUrl: 'https://heykody.dev',
			user: { userId: 'user-123' },
			remoteConnectors: [{ kind: 'lighting', instanceId: 'default' }],
		}),
		{
			resolveSecretValue: async (secret, capabilityName) =>
				`${secret.name}-${capabilityName}-resolved`,
		},
	)
	await resolvedCodemode.lighting_default_lutron_set_credentials({
		processorId: 'lutron-192-168-0-41',
		username: '{{secret:lutronUsername|scope=user}}',
		password: '{{secret:lutronPassword|scope=user}}',
	})
	expect(toolArguments).toEqual({
		processorId: 'lutron-192-168-0-41',
		username: 'lutronUsername-lighting_default_lutron_set_credentials-resolved',
		password: 'lutronPassword-lighting_default_lutron_set_credentials-resolved',
	})

	const resolveSecretSpy = vi
		.spyOn(secretService, 'resolveSecret')
		.mockResolvedValue({
			found: true,
			value: 'lutronUsername-resolved',
			scope: 'user',
			allowedHosts: [],
			allowedCapabilities: ['some_other_capability'],
		})
	const deniedCodemode = await buildCodemodeFns(
		connectorEnv,
		createMcpCallerContext({
			baseUrl: 'https://heykody.dev',
			user: { userId: 'user-123' },
			remoteConnectors: [{ kind: 'lighting', instanceId: 'default' }],
		}),
	)
	try {
		await expect(
			deniedCodemode.lighting_default_lutron_set_credentials({
				username: '{{secret:lutronUsername|scope=user}}',
			}),
		).rejects.toThrow(
			/not allowed for capability "lighting_default_lutron_set_credentials"/,
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
		const trackedCodemode = await buildCodemodeFns(
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
		const result = await trackedCodemode.secret_set({
			name: 'spotifyAccessToken',
			value: 'fresh-access-token',
		})
		expect(result).toEqual({ name: 'spotifyAccessToken' })
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

test('runCodemodeWithRegistry routes module and snippet inputs through the expected execution path', async () => {
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
		const moduleCode = `import { codemode } from 'kody:runtime'

export default async function run() {
	return await codemode.meta_list_capabilities({})
}`
		const fencedModuleCode = `\`\`\`ts
import { codemode } from 'kody:runtime'

export default async function run() {
	return await codemode.meta_list_capabilities({})
}
\`\`\``
		const typescriptModuleCode = `import type { ExecuteResult } from '@cloudflare/codemode'

type ModuleOutput = ExecuteResult | null

export default async function run(): Promise<ModuleOutput> {
	return null
}`
		const moduleResult = await runCodemodeWithRegistry(
			env,
			callerContext,
			moduleCode,
		)
		expect(moduleResult.result).toBe('ok')
		expect(buildBundleMock).toHaveBeenNthCalledWith(
			1,
			expect.objectContaining({
				sourceFiles: {
					'entry.ts': moduleCode,
				},
				entryPoint: 'entry.ts',
			}),
		)

		const fencedModuleResult = await runCodemodeWithRegistry(
			env,
			callerContext,
			fencedModuleCode,
		)
		expect(fencedModuleResult.result).toBe('ok')
		expect(buildBundleMock).toHaveBeenNthCalledWith(
			2,
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

		const typescriptModuleResult = await runCodemodeWithRegistry(
			env,
			callerContext,
			typescriptModuleCode,
		)
		expect(typescriptModuleResult.result).toBe('ok')
		expect(buildBundleMock).toHaveBeenNthCalledWith(
			3,
			expect.objectContaining({
				sourceFiles: {
					'entry.ts': typescriptModuleCode,
				},
			}),
		)

		const snippetResult = await runCodemodeWithRegistry(
			env,
			callerContext,
			'return "ok"',
		)
		expect(snippetResult.result).toBe('ok')
		expect(buildBundleMock).toHaveBeenCalledTimes(3)
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

test('runBundledModuleWithRegistry passes params and injects runtime helpers', async () => {
	const created: Array<WorkflowInstanceCreateOptions<unknown>> = []
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
							async run() {
								return { success: true }
							},
						}
					},
				}
			},
		} as unknown as D1Database,
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

		createExecuteExecutorSpy.mockImplementation((input) => {
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

		const serviceResult = await runBundledModuleWithRegistry(
			env,
			callerContext,
			bundle,
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
		expect(serviceResult.result).toBe('ok')
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
						expect(providers).toHaveLength(2)
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
					check: async (input) => ({
						ok: true,
						invoke: input as {
							kodyId: string
							exportName: string
						},
						contract: {
							packageId: 'pkg-discord-general-chat',
							kodyId: 'discord-general-chat',
							name: '@kentcdodds/discord-general-chat',
							sourceId: 'source-discord-general-chat',
							publishedCommit: 'commit-1',
							exportName: './handle-discord-message-created',
							runtimeTarget: 'src/handle-discord-message-created.ts',
							warnings: [],
						},
					}),
					invoke: async (input) => ({ ok: true, input }),
					invokeChecked: async (input) => ({ ok: true, input }),
				},
			},
		)
		expect(packageResult.result).toBe('ok')
		expect(providerFns).not.toBeNull()
		expect(providerFns?.package_invoke_check).toBeUndefined()
		expect(providerFns?.package_invoke).toBeUndefined()
		expect(providerFns?.package_invoke_checked).toBeUndefined()
		expect(packageBridgeFns).not.toBeNull()
		await expect(
			packageBridgeFns?.check({
				kodyId: 'discord-general-chat',
				exportName: './handle-discord-message-created',
			}),
		).resolves.toMatchObject({
			ok: true,
			invoke: {
				kodyId: 'discord-general-chat',
				exportName: './handle-discord-message-created',
			},
		})
		await expect(
			packageBridgeFns?.invoke({
				kodyId: 'discord-general-chat',
				exportName: './handle-discord-message-created',
			}),
		).resolves.toEqual({
			ok: true,
			input: {
				kodyId: 'discord-general-chat',
				exportName: './handle-discord-message-created',
			},
		})
		await expect(
			packageBridgeFns?.invokeChecked({
				kodyId: 'discord-general-chat',
				exportName: './handle-discord-message-created',
			}),
		).resolves.toEqual({
			ok: true,
			input: {
				kodyId: 'discord-general-chat',
				exportName: './handle-discord-message-created',
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
