import { expect, test, vi } from 'vitest'
import { createMcpCallerContext } from '#mcp/context.ts'
import {
	createExecutePackageInvokeTools,
	createPackageRuntimeInvokeTools,
	createPackageEventTools,
	invokePackageExport,
	invokePackageSubscription,
} from './service.ts'

const repoMockModule = vi.hoisted(() => ({
	getSavedPackageById: vi.fn(),
	getSavedPackageByKodyId: vi.fn(),
	listSavedPackagesByUserId: vi.fn(),
	loadPackageManifestBySourceId: vi.fn(),
	loadPackageSourceBySourceId: vi.fn(),
	getEntitySourceById: vi.fn(),
	loadPublishedBundleArtifactByIdentity: vi.fn(),
	persistPublishedBundleArtifact: vi.fn(),
	typecheckPackageEntrypointsFromSourceFiles: vi.fn(),
	runBundledModuleWithRegistry: vi.fn(),
}))

vi.mock('#worker/package-registry/repo.ts', () => ({
	getSavedPackageById: (...args: Array<unknown>) =>
		repoMockModule.getSavedPackageById(...args),
	getSavedPackageByKodyId: (...args: Array<unknown>) =>
		repoMockModule.getSavedPackageByKodyId(...args),
	listSavedPackagesByUserId: (...args: Array<unknown>) =>
		repoMockModule.listSavedPackagesByUserId(...args),
}))

vi.mock('#worker/package-registry/source.ts', () => ({
	loadPackageManifestBySourceId: (...args: Array<unknown>) =>
		repoMockModule.loadPackageManifestBySourceId(...args),
	loadPackageSourceBySourceId: (...args: Array<unknown>) =>
		repoMockModule.loadPackageSourceBySourceId(...args),
}))

vi.mock('#worker/repo/entity-sources.ts', () => ({
	getEntitySourceById: (...args: Array<unknown>) =>
		repoMockModule.getEntitySourceById(...args),
}))

vi.mock('#worker/package-runtime/published-bundle-artifacts.ts', () => ({
	loadPublishedBundleArtifactByIdentity: (...args: Array<unknown>) =>
		repoMockModule.loadPublishedBundleArtifactByIdentity(...args),
	persistPublishedBundleArtifact: (...args: Array<unknown>) =>
		repoMockModule.persistPublishedBundleArtifact(...args),
}))

vi.mock('#worker/repo/checks.ts', () => ({
	typecheckPackageEntrypointsFromSourceFiles: (...args: Array<unknown>) =>
		repoMockModule.typecheckPackageEntrypointsFromSourceFiles(...args),
}))

vi.mock('#mcp/run-codemode-registry.ts', () => ({
	runBundledModuleWithRegistry: (...args: Array<unknown>) =>
		repoMockModule.runBundledModuleWithRegistry(...args),
}))

function createDatabase(options: { failInsert?: boolean } = {}) {
	const tables = new Map<string, Array<Record<string, unknown>>>([
		['package_invocations', []],
	])

	const clone = <T>(value: T): T => structuredClone(value)

	function getTable(name: string) {
		const table = tables.get(name)
		if (!table) {
			throw new Error(`Unknown table ${name}`)
		}
		return table
	}

	function selectOne(
		tableName: string,
		predicate: (row: Record<string, unknown>) => boolean,
	) {
		return clone(getTable(tableName).find(predicate) ?? null)
	}

	const db = {
		prepare(query: string) {
			return {
				bind(...params: Array<unknown>) {
					return {
						async first<T = Record<string, unknown>>() {
							if (
								query.includes('FROM package_invocations') &&
								query.includes('idempotency_key = ?')
							) {
								return selectOne(
									'package_invocations',
									(row) =>
										row['user_id'] === params[0] &&
										row['token_id'] === params[1] &&
										row['package_id'] === params[2] &&
										row['export_name'] === params[3] &&
										row['idempotency_key'] === params[4],
								) as T | null
							}
							return null
						},
						async run() {
							if (query.includes('INTO package_invocations')) {
								if (options.failInsert) {
									throw new Error('D1 unavailable')
								}
								const table = getTable('package_invocations')
								const existing = table.find(
									(row) =>
										row['user_id'] === params[1] &&
										row['token_id'] === params[2] &&
										row['package_id'] === params[3] &&
										row['export_name'] === params[5] &&
										row['idempotency_key'] === params[6],
								)
								if (existing) {
									return { meta: { changes: 0, last_row_id: 0 } }
								}
								table.push(
									clone({
										id: params[0],
										user_id: params[1],
										token_id: params[2],
										package_id: params[3],
										package_kody_id: params[4],
										export_name: params[5],
										idempotency_key: params[6],
										request_hash: params[7],
										source: params[8],
										topic: params[9],
										status: params[10],
										response_json: params[11],
										created_at: params[12],
										updated_at: params[13],
									}),
								)
								return { meta: { changes: 1, last_row_id: 1 } }
							}
							if (query.includes('UPDATE package_invocations')) {
								const table = getTable('package_invocations')
								const existing = table.find(
									(row) =>
										row['id'] === params[3] && row['user_id'] === params[4],
								)
								if (!existing) {
									return { meta: { changes: 0, last_row_id: 0 } }
								}
								existing['status'] = params[0]
								existing['response_json'] = params[1]
								existing['updated_at'] = params[2]
								return { meta: { changes: 1, last_row_id: 0 } }
							}
							throw new Error(`Unhandled query: ${query}`)
						},
					}
				},
			}
		},
		corruptStoredResponses() {
			for (const row of getTable('package_invocations')) {
				row['response_json'] = '{"status":200,"body":null}'
			}
		},
	} as unknown as D1Database & { corruptStoredResponses(): void }
	return db
}

function createEnv(db: D1Database) {
	return {
		APP_DB: db,
		BUNDLE_ARTIFACTS_KV: {
			get: async () => null,
			put: async () => undefined,
			delete: async () => undefined,
		},
	} as unknown as Env
}

function createToken(
	overrides: Partial<{
		exportNames: Array<string>
		sources: Array<string>
		remoteConnectors: Array<{ kind: string; instanceId: string }>
	}> = {},
) {
	return {
		tokenId: 'discord-gateway',
		userId: 'user-123',
		email: 'me@example.com',
		displayName: 'me',
		packageKodyIds: ['discord-gateway'],
		exportNames: overrides.exportNames ?? ['./dispatch-message-created'],
		sources: overrides.sources ?? ['discord-gateway'],
		remoteConnectors: overrides.remoteConnectors,
	} as const
}

function seedPackageResolution() {
	repoMockModule.getSavedPackageById.mockResolvedValue(null)
	repoMockModule.getSavedPackageByKodyId.mockResolvedValue({
		id: 'pkg-1',
		userId: 'user-123',
		name: '@kentcdodds/discord-gateway',
		kodyId: 'discord-gateway',
		description: 'Discord gateway helpers',
		tags: [],
		searchText: null,
		sourceId: 'source-1',
		hasApp: true,
		createdAt: '2026-04-27T00:00:00.000Z',
		updatedAt: '2026-04-27T00:00:00.000Z',
	})
	repoMockModule.loadPackageManifestBySourceId.mockResolvedValue({
		source: {
			id: 'source-1',
			user_id: 'user-123',
			entity_kind: 'package',
			entity_id: 'pkg-1',
			repo_id: 'repo-1',
			published_commit: 'commit-1',
			indexed_commit: null,
			manifest_path: 'package.json',
			source_root: '/',
			created_at: '2026-04-27T00:00:00.000Z',
			updated_at: '2026-04-27T00:00:00.000Z',
		},
		manifest: {
			name: '@kentcdodds/discord-gateway',
			exports: {
				'./dispatch-message-created': './src/dispatch-message-created.ts',
			},
			kody: {
				id: 'discord-gateway',
				description: 'Discord gateway helpers',
				app: {
					entry: './src/app.ts',
				},
			},
		},
	})
	repoMockModule.loadPackageSourceBySourceId.mockResolvedValue({
		source: {
			id: 'source-1',
			user_id: 'user-123',
			entity_kind: 'package',
			entity_id: 'pkg-1',
			repo_id: 'repo-1',
			published_commit: 'commit-1',
			indexed_commit: null,
			manifest_path: 'package.json',
			source_root: '/',
			created_at: '2026-04-27T00:00:00.000Z',
			updated_at: '2026-04-27T00:00:00.000Z',
		},
		manifest: {
			name: '@kentcdodds/discord-gateway',
			exports: {
				'./dispatch-message-created': './src/dispatch-message-created.ts',
			},
			kody: {
				id: 'discord-gateway',
				description: 'Discord gateway helpers',
				app: {
					entry: './src/app.ts',
				},
			},
		},
		files: {
			'package.json': JSON.stringify({
				name: '@kentcdodds/discord-gateway',
				exports: {
					'./dispatch-message-created': './src/dispatch-message-created.ts',
				},
				kody: {
					id: 'discord-gateway',
					description: 'Discord gateway helpers',
					app: {
						entry: './src/app.ts',
					},
				},
			}),
			'src/dispatch-message-created.ts':
				'export default async function run(){ return { ok: true } }',
		},
	})
	repoMockModule.getEntitySourceById.mockResolvedValue({
		id: 'source-1',
		user_id: 'user-123',
		entity_kind: 'package',
		entity_id: 'pkg-1',
		repo_id: 'repo-1',
		published_commit: 'commit-1',
		indexed_commit: null,
		manifest_path: 'package.json',
		source_root: '/',
		created_at: '2026-04-27T00:00:00.000Z',
		updated_at: '2026-04-27T00:00:00.000Z',
	})
	repoMockModule.loadPublishedBundleArtifactByIdentity.mockResolvedValue({
		row: {
			id: 'artifact-1',
		},
		artifact: {
			version: 1,
			kind: 'module',
			artifactName: './dispatch-message-created',
			sourceId: 'source-1',
			publishedCommit: 'commit-1',
			entryPoint: 'src/dispatch-message-created.ts',
			mainModule: 'dist/index.js',
			modules: {
				'dist/index.js':
					'export default async function run(){ return { ok: true } }',
			},
			dependencies: [],
			packageContext: {
				packageId: 'pkg-1',
				kodyId: 'discord-gateway',
				sourceId: 'source-1',
			},
			serviceContext: null,
			createdAt: '2026-04-27T00:00:00.000Z',
		},
	})
	repoMockModule.typecheckPackageEntrypointsFromSourceFiles.mockResolvedValue({
		ok: true,
		message: 'ok',
	})
	repoMockModule.persistPublishedBundleArtifact.mockResolvedValue('kv:key')
}

function createSavedPackage(input: {
	id: string
	sourceId: string
	name: string
	kodyId: string
	description?: string
}) {
	return {
		id: input.id,
		userId: 'user-123',
		name: input.name,
		kodyId: input.kodyId,
		description: input.description ?? `${input.kodyId} package`,
		tags: [],
		searchText: null,
		sourceId: input.sourceId,
		hasApp: false,
		createdAt: '2026-05-10T00:00:00.000Z',
		updatedAt: '2026-05-10T00:00:00.000Z',
	}
}

function createSource(input: { id: string; entityId: string; commit: string }) {
	return {
		id: input.id,
		user_id: 'user-123',
		entity_kind: 'package',
		entity_id: input.entityId,
		repo_id: `repo-${input.id}`,
		published_commit: input.commit,
		indexed_commit: null,
		manifest_path: 'package.json',
		source_root: '/',
		created_at: '2026-05-10T00:00:00.000Z',
		updated_at: '2026-05-10T00:00:00.000Z',
	}
}

function createManifest(input: {
	name: string
	kodyId: string
	exportName: string
	entryPoint: string
	emits?: Record<string, { description: string }>
	subscriptions?: Record<string, { handler: string; description?: string }>
}) {
	return {
		name: input.name,
		exports: {
			[input.exportName]: input.entryPoint,
		},
		kody: {
			id: input.kodyId,
			description: `${input.kodyId} package`,
			emits: input.emits,
			subscriptions: input.subscriptions,
		},
	}
}

function createModuleArtifact(input: {
	sourceId: string
	publishedCommit: string
	artifactName: string
	entryPoint: string
	mainModule: string
	packageContext: {
		packageId: string
		kodyId: string
		sourceId: string
	}
}) {
	return {
		row: {
			id: `artifact-${input.packageContext.packageId}`,
		},
		artifact: {
			version: 1,
			kind: 'module',
			artifactName: input.artifactName,
			sourceId: input.sourceId,
			publishedCommit: input.publishedCommit,
			entryPoint: input.entryPoint,
			mainModule: input.mainModule,
			modules: {
				[input.mainModule]:
					'export default async function run(){ return { ok: true } }',
			},
			dependencies: [],
			packageContext: input.packageContext,
			serviceContext: null,
			createdAt: '2026-05-10T00:00:00.000Z',
		},
	}
}

function seedRuntimeDispatchPackages() {
	const gateway = createSavedPackage({
		id: 'pkg-gateway',
		sourceId: 'source-gateway',
		name: '@kentcdodds/discord-gateway',
		kodyId: 'discord-gateway',
	})
	const subscriber = createSavedPackage({
		id: 'pkg-subscriber',
		sourceId: 'source-subscriber',
		name: '@kentcdodds/discord-general-chat',
		kodyId: 'discord-general-chat',
	})
	const sources = new Map([
		[
			'source-gateway',
			createSource({
				id: 'source-gateway',
				entityId: 'pkg-gateway',
				commit: 'gateway-commit-1',
			}),
		],
		[
			'source-subscriber',
			createSource({
				id: 'source-subscriber',
				entityId: 'pkg-subscriber',
				commit: 'subscriber-commit-1',
			}),
		],
	])
	const manifests = new Map([
		[
			'source-gateway',
			createManifest({
				name: gateway.name,
				kodyId: gateway.kodyId,
				exportName: './dispatch-message-created',
				entryPoint: './src/dispatch-message-created.ts',
				emits: {
					'@kentcdodds/discord.message.created': {
						description: 'A Discord message was created.',
					},
				},
			}),
		],
		[
			'source-subscriber',
			createManifest({
				name: subscriber.name,
				kodyId: subscriber.kodyId,
				exportName: './handle-discord-message-created',
				entryPoint: './src/handle-discord-message-created.ts',
				subscriptions: {
					'@kentcdodds/discord.message.created': {
						handler: './src/handle-discord-message-created.ts',
						description: 'Handle Discord message events.',
					},
				},
			}),
		],
	])
	const sourceFiles = new Map([
		[
			'source-gateway',
			{
				'package.json': JSON.stringify(manifests.get('source-gateway')),
				'src/dispatch-message-created.ts':
					'export default async function dispatchMessageCreated(input: Record<string, unknown>) { return input }',
			},
		],
		[
			'source-subscriber',
			{
				'package.json': JSON.stringify(manifests.get('source-subscriber')),
				'src/handle-discord-message-created.ts': `/**
 * Handle a Discord message-created event.
 */
export default async function handleDiscordMessageCreated(input: { event: { id: string }, dryRun?: boolean }): Promise<{ handled: boolean }> {
	return { handled: true }
}`,
			},
		],
	])
	repoMockModule.getSavedPackageById.mockResolvedValue(null)
	repoMockModule.getSavedPackageByKodyId.mockImplementation(
		async (_db: unknown, input: { userId: string; kodyId: string }) => {
			expect(input.userId).toBe('user-123')
			if (input.kodyId === gateway.kodyId) return gateway
			if (input.kodyId === subscriber.kodyId) return subscriber
			return null
		},
	)
	repoMockModule.listSavedPackagesByUserId.mockImplementation(
		async (_db: unknown, input: { userId: string }) => {
			expect(input.userId).toBe('user-123')
			return [gateway, subscriber]
		},
	)
	repoMockModule.loadPackageManifestBySourceId.mockImplementation(
		async (input: { sourceId: string }) => ({
			source: sources.get(input.sourceId),
			manifest: manifests.get(input.sourceId),
		}),
	)
	repoMockModule.loadPackageSourceBySourceId.mockImplementation(
		async (input: { sourceId: string }) => ({
			source: sources.get(input.sourceId),
			manifest: manifests.get(input.sourceId),
			files: sourceFiles.get(input.sourceId) ?? {},
		}),
	)
	repoMockModule.getEntitySourceById.mockImplementation(
		async (_db: unknown, sourceId: string) => sources.get(sourceId) ?? null,
	)
	repoMockModule.loadPublishedBundleArtifactByIdentity.mockImplementation(
		async (input: {
			sourceId: string
			artifactName: string
			entryPoint: string
		}) => {
			if (input.sourceId === 'source-gateway') {
				return createModuleArtifact({
					sourceId: 'source-gateway',
					publishedCommit: 'gateway-commit-1',
					artifactName: './dispatch-message-created',
					entryPoint: 'src/dispatch-message-created.ts',
					mainModule: 'dist/gateway.js',
					packageContext: {
						packageId: gateway.id,
						kodyId: gateway.kodyId,
						sourceId: gateway.sourceId,
					},
				})
			}
			if (input.sourceId === 'source-subscriber') {
				return createModuleArtifact({
					sourceId: 'source-subscriber',
					publishedCommit: 'subscriber-commit-1',
					artifactName:
						input.artifactName ===
						'subscription:@kentcdodds/discord.message.created'
							? 'subscription:@kentcdodds/discord.message.created'
							: './handle-discord-message-created',
					entryPoint: 'src/handle-discord-message-created.ts',
					mainModule: 'dist/subscriber.js',
					packageContext: {
						packageId: subscriber.id,
						kodyId: subscriber.kodyId,
						sourceId: subscriber.sourceId,
					},
				})
			}
			return null
		},
	)
	return { gateway, manifests, sourceFiles, sources, subscriber }
}

function createRuntimeDispatchTools(db: D1Database) {
	return createPackageRuntimeInvokeTools({
		env: createEnv(db),
		baseUrl: 'https://kody.dev',
		callerContext: createMcpCallerContext({
			baseUrl: 'https://kody.dev',
			user: {
				userId: 'user-123',
				email: 'me@example.com',
				displayName: 'Me',
			},
		}),
		packageContext: {
			packageId: 'pkg-gateway',
			kodyId: 'discord-gateway',
			sourceId: 'source-gateway',
		},
		parentRuntimeDebug: {
			packageId: 'pkg-gateway',
			kodyId: 'discord-gateway',
			sourceId: 'source-gateway',
			surface: 'export',
			name: './dispatch-message-created',
			idempotencyKey: 'message-1',
		},
		packageInvokeDepth: 0,
	})
}

function createRuntimeEventTools(db: D1Database) {
	return createPackageEventTools({
		env: createEnv(db),
		baseUrl: 'https://kody.dev',
		callerContext: createMcpCallerContext({
			baseUrl: 'https://kody.dev',
			user: {
				userId: 'user-123',
				email: 'me@example.com',
				displayName: 'Me',
			},
		}),
		packageContext: {
			packageId: 'pkg-gateway',
			kodyId: 'discord-gateway',
			sourceId: 'source-gateway',
		},
		parentRuntimeDebug: {
			packageId: 'pkg-gateway',
			kodyId: 'discord-gateway',
			sourceId: 'source-gateway',
			surface: 'export',
			name: './dispatch-message-created',
			idempotencyKey: 'message-1',
		},
		packageInvokeDepth: 0,
	})
}

test('invokePackageExport executes a scoped package export successfully', async () => {
	const db = createDatabase()
	seedPackageResolution()
	repoMockModule.runBundledModuleWithRegistry.mockResolvedValue({
		result: { reply: 'hello discord' },
		logs: ['dispatched'],
	})

	const response = await invokePackageExport({
		env: createEnv(db),
		baseUrl: 'https://kody.dev',
		token: createToken({
			remoteConnectors: [{ kind: 'home', instanceId: 'default' }],
		}),
		request: {
			packageIdOrKodyId: 'discord-gateway',
			exportName: 'dispatch-message-created',
			params: { content: 'hi' },
			idempotencyKey: 'evt-1',
			topic: 'discord.message.created',
		},
	})

	expect(response.status).toBe(200)
	expect(response.body).toMatchObject({
		ok: true,
		exportName: './dispatch-message-created',
		idempotency: {
			key: 'evt-1',
			replayed: false,
		},
		result: { reply: 'hello discord' },
		logs: ['dispatched'],
	})
	expect(repoMockModule.runBundledModuleWithRegistry).toHaveBeenCalledTimes(1)
	expect(repoMockModule.runBundledModuleWithRegistry).toHaveBeenCalledWith(
		expect.anything(),
		expect.objectContaining({
			remoteConnectors: [{ kind: 'home', instanceId: 'default' }],
		}),
		expect.anything(),
		expect.anything(),
		expect.anything(),
	)
	const runOptions =
		repoMockModule.runBundledModuleWithRegistry.mock.calls[0]?.[4]
	expect(runOptions).toMatchObject({
		packageContext: {
			packageId: 'pkg-1',
			kodyId: 'discord-gateway',
			sourceId: 'source-1',
		},
	})
	expect(
		(runOptions as { packageInvokeTools?: { invoke?: unknown } })
			.packageInvokeTools?.invoke,
	).toEqual(expect.any(Function))
})

test('package runtime can dynamically invoke the current published export from another package', async () => {
	const db = createDatabase()
	seedRuntimeDispatchPackages()
	let subscriberVersion = 'v1'
	repoMockModule.runBundledModuleWithRegistry.mockImplementation(
		async (
			_env: unknown,
			_callerContext: unknown,
			bundle: { mainModule: string },
			params: { event?: { id?: string } } | undefined,
			options: {
				packageInvokeTools?: {
					invoke(input: Record<string, unknown>): Promise<unknown>
				}
			},
		) => {
			if (bundle.mainModule === 'dist/gateway.js') {
				return {
					result: await options.packageInvokeTools?.invoke({
						kodyId: 'discord-general-chat',
						exportName: './handle-discord-message-created',
						params: { event: params?.event },
					}),
					logs: [],
				}
			}
			if (bundle.mainModule === 'dist/subscriber.js') {
				return {
					result: {
						version: subscriberVersion,
						eventId: params?.event?.id,
					},
					logs: [],
				}
			}
			throw new Error(`Unexpected bundle ${bundle.mainModule}`)
		},
	)

	const first = await invokePackageExport({
		env: createEnv(db),
		baseUrl: 'https://kody.dev',
		token: {
			...createToken(),
			packageKodyIds: ['discord-gateway'],
			exportNames: ['./dispatch-message-created'],
		},
		request: {
			packageIdOrKodyId: 'discord-gateway',
			exportName: './dispatch-message-created',
			params: { event: { id: 'message-1' } },
			idempotencyKey: 'gateway-message-1',
		},
	})
	subscriberVersion = 'v2'
	const second = await invokePackageExport({
		env: createEnv(db),
		baseUrl: 'https://kody.dev',
		token: {
			...createToken(),
			packageKodyIds: ['discord-gateway'],
			exportNames: ['./dispatch-message-created'],
		},
		request: {
			packageIdOrKodyId: 'discord-gateway',
			exportName: './dispatch-message-created',
			params: { event: { id: 'message-2' } },
			idempotencyKey: 'gateway-message-2',
		},
	})

	expect(first.status).toBe(200)
	expect(first.body).toMatchObject({
		ok: true,
		result: {
			version: 'v1',
			eventId: 'message-1',
		},
	})
	expect(second.status).toBe(200)
	expect(second.body).toMatchObject({
		ok: true,
		result: {
			version: 'v2',
			eventId: 'message-2',
		},
	})
	expect(repoMockModule.runBundledModuleWithRegistry).toHaveBeenCalledTimes(4)
	const firstGatewayRunOptions =
		repoMockModule.runBundledModuleWithRegistry.mock.calls[0]?.[4]
	const firstSubscriberRunOptions =
		repoMockModule.runBundledModuleWithRegistry.mock.calls[1]?.[4]
	expect(
		(firstGatewayRunOptions as { packageInvokeTools?: { invoke?: unknown } })
			.packageInvokeTools?.invoke,
	).toEqual(expect.any(Function))
	expect(firstSubscriberRunOptions).toMatchObject({
		packageContext: {
			packageId: 'pkg-subscriber',
			kodyId: 'discord-general-chat',
			sourceId: 'source-subscriber',
		},
	})
	expect(
		(firstSubscriberRunOptions as { packageInvokeTools?: { invoke?: unknown } })
			.packageInvokeTools?.invoke,
	).toEqual(expect.any(Function))
})

test('package runtime dispatches declared events to same-user package subscriptions', async () => {
	const db = createDatabase()
	seedRuntimeDispatchPackages()
	repoMockModule.runBundledModuleWithRegistry.mockClear()
	repoMockModule.runBundledModuleWithRegistry.mockImplementation(
		async (
			_env: unknown,
			_callerContext: unknown,
			_bundle: unknown,
			params: Record<string, unknown> | undefined,
			options: { packageEventTools?: { dispatch?: unknown } },
		) => ({
			result: {
				received: params,
				hasEventDispatch:
					typeof options.packageEventTools?.dispatch === 'function',
			},
			logs: [],
		}),
	)
	const tools = createRuntimeEventTools(db)

	const first = await tools.dispatch({
		topic: '@kentcdodds/discord.message.created',
		idempotencyKey: 'discord:message-create:123',
		payload: {
			messageId: '123',
			channelId: '456',
		},
	})
	const second = await tools.dispatch({
		topic: '@kentcdodds/discord.message.created',
		idempotencyKey: 'discord:message-create:123',
		payload: {
			messageId: '123',
			channelId: '456',
		},
	})

	expect(repoMockModule.runBundledModuleWithRegistry).toHaveBeenCalledTimes(1)
	expect(
		repoMockModule.runBundledModuleWithRegistry.mock.calls[0]?.[3],
	).toEqual({
		event: '@kentcdodds/discord.message.created',
		source: {
			type: 'package',
			package_id: 'pkg-gateway',
			kody_id: 'discord-gateway',
		},
		idempotency_key: 'discord:message-create:123',
		payload: {
			messageId: '123',
			channelId: '456',
		},
	})
	expect(first).toMatchObject({
		topic: '@kentcdodds/discord.message.created',
		source: {
			type: 'package',
			packageId: 'pkg-gateway',
			kodyId: 'discord-gateway',
		},
		delivered: 1,
		failed: 0,
		subscribers: [
			{
				packageId: 'pkg-subscriber',
				kodyId: 'discord-general-chat',
				handler: 'src/handle-discord-message-created.ts',
				status: 'completed',
			},
		],
	})
	expect(second).toMatchObject({
		delivered: 1,
		failed: 0,
		subscribers: [
			{
				packageId: 'pkg-subscriber',
				kodyId: 'discord-general-chat',
				status: 'replayed',
			},
		],
	})
})

test('package runtime rejects dispatch for undeclared emitted event topics', async () => {
	const db = createDatabase()
	seedRuntimeDispatchPackages()
	repoMockModule.runBundledModuleWithRegistry.mockClear()
	repoMockModule.runBundledModuleWithRegistry.mockResolvedValue({
		result: { ok: true },
		logs: [],
	})
	const tools = createRuntimeEventTools(db)

	await expect(
		tools.dispatch({
			topic: '@kentcdodds/discord.reaction.created',
			idempotencyKey: 'discord:reaction-create:123',
			payload: {
				reactionId: '123',
			},
		}),
	).rejects.toThrow(
		'does not declare emitted event "@kentcdodds/discord.reaction.created"',
	)
	expect(repoMockModule.runBundledModuleWithRegistry).not.toHaveBeenCalled()
})

test('package runtime fails dispatch when subscriber manifest discovery fails', async () => {
	const db = createDatabase()
	const { manifests, sources } = seedRuntimeDispatchPackages()
	repoMockModule.runBundledModuleWithRegistry.mockClear()
	repoMockModule.runBundledModuleWithRegistry.mockResolvedValue({
		result: { ok: true },
		logs: [],
	})
	repoMockModule.loadPackageManifestBySourceId.mockImplementation(
		async (input: { sourceId: string }) => {
			if (input.sourceId === 'source-subscriber') {
				throw new Error('manifest unavailable')
			}
			return {
				source: sources.get(input.sourceId),
				manifest: manifests.get(input.sourceId),
			}
		},
	)
	const tools = createRuntimeEventTools(db)

	await expect(
		tools.dispatch({
			topic: '@kentcdodds/discord.message.created',
			idempotencyKey: 'discord:message-create:123',
			payload: {
				messageId: '123',
			},
		}),
	).rejects.toThrow(
		'Failed to load package manifest for package event dispatch: discord-general-chat (pkg-subscriber).',
	)
	expect(repoMockModule.runBundledModuleWithRegistry).not.toHaveBeenCalled()
})

test('package runtime checks and invokes another package with current contract metadata', async () => {
	const db = createDatabase()
	seedRuntimeDispatchPackages()
	repoMockModule.runBundledModuleWithRegistry.mockResolvedValue({
		result: { handled: true, eventId: 'message-1' },
		logs: [],
	})
	repoMockModule.loadPackageManifestBySourceId.mockClear()
	const tools = createRuntimeDispatchTools(db)

	const check = await tools.check({
		kodyId: 'discord-general-chat',
		exportName: 'handle-discord-message-created',
		params: { event: { id: 'message-1' }, dryRun: true },
		idempotencyKey: 'message-1',
		topic: 'discord.message.created',
	})

	expect(check).toMatchObject({
		ok: true,
		invoke: {
			kodyId: 'discord-general-chat',
			exportName: './handle-discord-message-created',
			params: { event: { id: 'message-1' }, dryRun: true },
			idempotencyKey: 'message-1',
			topic: 'discord.message.created',
		},
		contract: {
			packageId: 'pkg-subscriber',
			kodyId: 'discord-general-chat',
			name: '@kentcdodds/discord-general-chat',
			sourceId: 'source-subscriber',
			publishedCommit: 'subscriber-commit-1',
			exportName: './handle-discord-message-created',
			runtimeTarget: 'src/handle-discord-message-created.ts',
			description: 'Handle a Discord message-created event.',
			typeDefinition:
				'export default async function handleDiscordMessageCreated(input: { event: { id: string }, dryRun?: boolean }): Promise<{ handled: boolean }>',
		},
	})
	expect(check.ok && check.contract.warnings).toEqual([
		'No machine-readable params schema is published for package exports; params were only validated as a JSON object.',
	])
	expect(repoMockModule.loadPackageManifestBySourceId).toHaveBeenCalledTimes(1)
	if (!check.ok) throw new Error(check.message)

	const result = await tools.invoke(check.invoke)

	expect(result).toEqual({ handled: true, eventId: 'message-1' })
	expect(repoMockModule.runBundledModuleWithRegistry).toHaveBeenCalledTimes(1)
})

test('execute runtime invokeChecked invokes target package with execute provenance', async () => {
	const db = createDatabase()
	seedRuntimeDispatchPackages()
	repoMockModule.runBundledModuleWithRegistry.mockResolvedValue({
		result: { handled: true, eventId: 'message-1' },
		logs: [],
	})
	const callerContext = createMcpCallerContext({
		baseUrl: 'https://kody.dev',
		user: {
			userId: 'user-123',
			email: 'me@example.com',
			displayName: 'Me',
		},
	})
	const tools = createExecutePackageInvokeTools({
		env: createEnv(db),
		baseUrl: 'https://kody.dev',
		callerContext,
	})

	const result = await tools.invokeChecked({
		kodyId: 'discord-general-chat',
		exportName: './handle-discord-message-created',
		params: { event: { id: 'message-1' } },
	})

	expect(result).toEqual({ handled: true, eventId: 'message-1' })
	expect(repoMockModule.runBundledModuleWithRegistry).toHaveBeenCalledTimes(1)
	const runCall = repoMockModule.runBundledModuleWithRegistry.mock.calls[0]
	expect(runCall?.[1]).toMatchObject({
		user: {
			userId: 'user-123',
			email: 'me@example.com',
			displayName: 'Me',
		},
		storageContext: {
			appId: 'pkg-subscriber',
			storageId: 'package:pkg-subscriber',
		},
	})
	expect(runCall?.[4]).toMatchObject({
		packageContext: {
			packageId: 'pkg-subscriber',
			kodyId: 'discord-general-chat',
			sourceId: 'source-subscriber',
		},
		runtimeDebug: {
			packageId: 'pkg-subscriber',
			kodyId: 'discord-general-chat',
			surface: 'export',
			metadata: {
				exportName: './handle-discord-message-created',
				source: 'execute',
				topic: null,
			},
		},
	})
	expect(
		(runCall?.[4] as { packageInvokeTools?: unknown } | undefined)
			?.packageInvokeTools,
	).toBeDefined()
})

test('package runtime check reads target package metadata changes without republishing caller', async () => {
	const db = createDatabase()
	const { sourceFiles, sources, subscriber } = seedRuntimeDispatchPackages()
	const tools = createRuntimeDispatchTools(db)

	const first = await tools.check({
		kodyId: 'discord-general-chat',
		exportName: './handle-discord-message-created',
		params: { event: { id: 'message-1' } },
	})
	sources.set(
		'source-subscriber',
		createSource({
			id: 'source-subscriber',
			entityId: subscriber.id,
			commit: 'subscriber-commit-2',
		}),
	)
	sourceFiles.set('source-subscriber', {
		'package.json':
			sourceFiles.get('source-subscriber')?.['package.json'] ?? '',
		'src/handle-discord-message-created.ts': `/**
 * Handle the current Discord message-created event contract.
 */
export default async function handleDiscordMessageCreated(input: { event: { id: string, guildId: string } }): Promise<{ handled: boolean, version: 2 }> {
	return { handled: true, version: 2 }
}`,
	})

	const second = await tools.check({
		kodyId: 'discord-general-chat',
		exportName: './handle-discord-message-created',
		params: { event: { id: 'message-2', guildId: 'guild-1' } },
	})

	expect(first).toMatchObject({
		ok: true,
		contract: {
			publishedCommit: 'subscriber-commit-1',
			description: 'Handle a Discord message-created event.',
		},
	})
	expect(second).toMatchObject({
		ok: true,
		contract: {
			publishedCommit: 'subscriber-commit-2',
			description: 'Handle the current Discord message-created event contract.',
			typeDefinition:
				'export default async function handleDiscordMessageCreated(input: { event: { id: string, guildId: string } }): Promise<{ handled: boolean, version: 2 }>',
		},
	})
})

test('package runtime check returns clear failures for invalid package export and params', async () => {
	const db = createDatabase()
	seedRuntimeDispatchPackages()
	const tools = createRuntimeDispatchTools(db)

	await expect(
		tools.check({
			kodyId: 'missing-package',
			exportName: './handle-discord-message-created',
			params: {},
		}),
	).resolves.toMatchObject({
		ok: false,
		message: 'Saved package "missing-package" was not found for this user.',
		problems: ['Saved package "missing-package" was not found for this user.'],
	})
	await expect(
		tools.check({
			kodyId: 'discord-general-chat',
			exportName: './missing-export',
			params: {},
		}),
	).resolves.toMatchObject({
		ok: false,
		problems: [
			'Package "discord-general-chat" does not define export "./missing-export".',
		],
		contract: {
			packageId: 'pkg-subscriber',
			kodyId: 'discord-general-chat',
			publishedCommit: 'subscriber-commit-1',
			exportName: './missing-export',
		},
	})
	await expect(
		tools.check({
			kodyId: 'discord-general-chat',
			exportName: './handle-discord-message-created',
			params: 'not-an-object',
		}),
	).resolves.toMatchObject({
		ok: false,
		message: 'packages.check params must be a JSON object when provided.',
		problems: ['packages.check params must be a JSON object when provided.'],
	})
})

test('package runtime invokeChecked fails before invocation when check fails', async () => {
	const db = createDatabase()
	seedRuntimeDispatchPackages()
	repoMockModule.runBundledModuleWithRegistry.mockClear()
	const tools = createRuntimeDispatchTools(db)

	await expect(
		tools.invokeChecked({
			kodyId: 'discord-general-chat',
			exportName: './missing-export',
			params: {},
		}),
	).rejects.toThrow(
		'packages.invokeChecked check failed: Package "discord-general-chat" does not define export "./missing-export".',
	)
	await expect(
		tools.invokeChecked({
			kodyId: 'discord-general-chat',
			exportName: './handle-discord-message-created',
			params: 'not-an-object',
		}),
	).rejects.toThrow(
		'packages.invokeChecked check failed: packages.invokeChecked params must be a JSON object when provided.',
	)
	expect(repoMockModule.runBundledModuleWithRegistry).not.toHaveBeenCalled()
})

test('package runtime invocation errors clearly when the target package or export is missing', async () => {
	const db = createDatabase()
	seedRuntimeDispatchPackages()
	const createTools = () =>
		createPackageRuntimeInvokeTools({
			env: createEnv(db),
			baseUrl: 'https://kody.dev',
			callerContext: createMcpCallerContext({
				baseUrl: 'https://kody.dev',
				user: {
					userId: 'user-123',
					email: 'me@example.com',
					displayName: 'Me',
				},
			}),
			packageContext: {
				packageId: 'pkg-gateway',
				kodyId: 'discord-gateway',
				sourceId: 'source-gateway',
			},
			parentRuntimeDebug: {
				packageId: 'pkg-gateway',
				kodyId: 'discord-gateway',
				sourceId: 'source-gateway',
				surface: 'export',
				name: './dispatch-message-created',
				idempotencyKey: 'message-1',
			},
			packageInvokeDepth: 0,
		})

	repoMockModule.getSavedPackageByKodyId.mockResolvedValue(null)
	await expect(
		createTools().invoke({
			kodyId: 'missing-package',
			exportName: './handle-discord-message-created',
		}),
	).rejects.toThrow(
		'[package_not_found] Saved package "missing-package" was not found for this user.',
	)

	repoMockModule.getSavedPackageByKodyId.mockReset()
	seedRuntimeDispatchPackages()
	await expect(
		createTools().invoke({
			kodyId: 'discord-general-chat',
			exportName: './missing-export',
			params: { event: { id: 'message-1' } },
		}),
	).rejects.toThrow('[export_not_found]')
})

test('package runtime auto idempotency keys include parent runtime identity', async () => {
	const db = createDatabase()
	seedRuntimeDispatchPackages()
	repoMockModule.runBundledModuleWithRegistry.mockImplementation(
		async (
			_env: unknown,
			_callerContext: unknown,
			bundle: { mainModule: string },
			params: { marker?: string; value?: number } | undefined,
		) => {
			expect(bundle.mainModule).toBe('dist/subscriber.js')
			return {
				result: {
					marker: params?.marker,
					value: params?.value,
				},
				logs: [],
			}
		},
	)
	const callerContext = createMcpCallerContext({
		baseUrl: 'https://kody.dev',
		user: {
			userId: 'user-123',
			email: 'me@example.com',
			displayName: 'Me',
		},
	})
	const packageContext = {
		packageId: 'pkg-gateway',
		kodyId: 'discord-gateway',
		sourceId: 'source-gateway',
	}
	const createToolsForParent = (name: string) =>
		createPackageRuntimeInvokeTools({
			env: createEnv(db),
			baseUrl: 'https://kody.dev',
			callerContext,
			packageContext,
			parentRuntimeDebug: {
				packageId: 'pkg-gateway',
				kodyId: 'discord-gateway',
				sourceId: 'source-gateway',
				surface: 'export',
				name,
				idempotencyKey: 'shared-domain-event',
			},
			packageInvokeDepth: 0,
		})

	const first = await createToolsForParent('./first-parent').invoke({
		kodyId: 'discord-general-chat',
		exportName: './handle-discord-message-created',
		params: { marker: 'same-child-call', value: 1 },
	})
	const second = await createToolsForParent('./second-parent').invoke({
		kodyId: 'discord-general-chat',
		exportName: './handle-discord-message-created',
		params: { marker: 'same-child-call', value: 1 },
	})

	expect(first).toEqual({ marker: 'same-child-call', value: 1 })
	expect(second).toEqual({ marker: 'same-child-call', value: 1 })
	expect(repoMockModule.runBundledModuleWithRegistry).toHaveBeenCalledTimes(2)
})

test('package runtime invocation requires package context and enforces loop depth', async () => {
	const db = createDatabase()
	seedRuntimeDispatchPackages()
	const callerContext = createMcpCallerContext({
		baseUrl: 'https://kody.dev',
		user: {
			userId: 'user-123',
			email: 'me@example.com',
			displayName: 'Me',
		},
	})
	const withoutPackageContext = createPackageRuntimeInvokeTools({
		env: createEnv(db),
		baseUrl: 'https://kody.dev',
		callerContext,
		packageContext: null,
		packageInvokeDepth: 0,
	})

	await expect(
		withoutPackageContext.invoke({
			kodyId: 'discord-general-chat',
			exportName: './handle-discord-message-created',
		}),
	).rejects.toThrow('packages.invoke requires a package runtime context.')

	const tooDeep = createPackageRuntimeInvokeTools({
		env: createEnv(db),
		baseUrl: 'https://kody.dev',
		callerContext,
		packageContext: {
			packageId: 'pkg-gateway',
			kodyId: 'discord-gateway',
			sourceId: 'source-gateway',
		},
		packageInvokeDepth: 8,
	})
	await expect(
		tooDeep.invoke({
			kodyId: 'discord-general-chat',
			exportName: './handle-discord-message-created',
		}),
	).rejects.toThrow(
		'packages.invoke exceeded the maximum nested invocation depth (8).',
	)
})

test('invokePackageExport replays the stored response for a duplicate idempotency key', async () => {
	const db = createDatabase()
	seedPackageResolution()
	repoMockModule.runBundledModuleWithRegistry.mockResolvedValue({
		result: { reply: 'hello discord' },
		logs: ['dispatched'],
	})

	const first = await invokePackageExport({
		env: createEnv(db),
		baseUrl: 'https://kody.dev',
		token: createToken(),
		request: {
			packageIdOrKodyId: 'discord-gateway',
			exportName: 'dispatch-message-created',
			params: { content: 'hi' },
			idempotencyKey: 'evt-1',
			source: 'discord-gateway',
			topic: 'discord.message.created',
		},
	})
	const second = await invokePackageExport({
		env: createEnv(db),
		baseUrl: 'https://kody.dev',
		token: createToken(),
		request: {
			packageIdOrKodyId: 'discord-gateway',
			exportName: 'dispatch-message-created',
			params: { content: 'hi' },
			idempotencyKey: 'evt-1',
			source: 'discord-gateway',
			topic: 'discord.message.created',
		},
	})

	expect(first.status).toBe(200)
	expect(second.status).toBe(200)
	expect(second.body).toMatchObject({
		ok: true,
		idempotency: {
			key: 'evt-1',
			replayed: true,
		},
	})
	expect(repoMockModule.runBundledModuleWithRegistry).toHaveBeenCalledTimes(1)
})

test('invokePackageExport does not re-execute terminal rows with unusable stored responses', async () => {
	const db = createDatabase()
	seedPackageResolution()
	repoMockModule.runBundledModuleWithRegistry.mockResolvedValue({
		result: { reply: 'hello discord' },
		logs: ['dispatched'],
	})

	const first = await invokePackageExport({
		env: createEnv(db),
		baseUrl: 'https://kody.dev',
		token: createToken(),
		request: {
			packageIdOrKodyId: 'discord-gateway',
			exportName: 'dispatch-message-created',
			params: { content: 'hi' },
			idempotencyKey: 'evt-corrupt',
			source: 'discord-gateway',
			topic: 'discord.message.created',
		},
	})
	;(
		db as unknown as { corruptStoredResponses(): void }
	).corruptStoredResponses()
	const second = await invokePackageExport({
		env: createEnv(db),
		baseUrl: 'https://kody.dev',
		token: createToken(),
		request: {
			packageIdOrKodyId: 'discord-gateway',
			exportName: 'dispatch-message-created',
			params: { content: 'hi' },
			idempotencyKey: 'evt-corrupt',
			source: 'discord-gateway',
			topic: 'discord.message.created',
		},
	})

	expect(first.status).toBe(200)
	expect(second.status).toBe(409)
	expect(second.body).toMatchObject({
		ok: false,
		error: {
			code: 'idempotency_response_unavailable',
		},
		idempotency: {
			key: 'evt-corrupt',
			replayed: false,
		},
	})
	expect(repoMockModule.runBundledModuleWithRegistry).toHaveBeenCalledTimes(1)
})

test('invokePackageExport returns structured errors when idempotency insert fails', async () => {
	const db = createDatabase({ failInsert: true })
	seedPackageResolution()

	const response = await invokePackageExport({
		env: createEnv(db),
		baseUrl: 'https://kody.dev',
		token: createToken(),
		request: {
			packageIdOrKodyId: 'discord-gateway',
			exportName: 'dispatch-message-created',
			params: { content: 'hi' },
			idempotencyKey: 'evt-insert-failure',
			source: 'discord-gateway',
			topic: 'discord.message.created',
		},
	})

	expect(response.status).toBe(500)
	expect(response.body).toMatchObject({
		ok: false,
		error: {
			code: 'idempotency_persistence_failed',
		},
		idempotency: {
			key: 'evt-insert-failure',
			replayed: false,
		},
	})
	expect(repoMockModule.runBundledModuleWithRegistry).not.toHaveBeenCalled()
})

test('invokePackageExport rejects explicitly disallowed source values', async () => {
	const db = createDatabase()
	seedPackageResolution()

	const response = await invokePackageExport({
		env: createEnv(db),
		baseUrl: 'https://kody.dev',
		token: createToken(),
		request: {
			packageIdOrKodyId: 'discord-gateway',
			exportName: 'dispatch-message-created',
			params: { content: 'hi' },
			idempotencyKey: 'evt-bad-source',
			source: 'other-gateway',
		},
	})

	expect(response.status).toBe(403)
	expect(response.body).toMatchObject({
		ok: false,
		error: {
			code: 'source_not_allowed',
		},
	})
	expect(repoMockModule.runBundledModuleWithRegistry).not.toHaveBeenCalled()
})

test('invokePackageExport rejects reusing an idempotency key for a different payload', async () => {
	const db = createDatabase()
	seedPackageResolution()
	repoMockModule.runBundledModuleWithRegistry.mockResolvedValue({
		result: { reply: 'hello discord' },
		logs: ['dispatched'],
	})

	await invokePackageExport({
		env: createEnv(db),
		baseUrl: 'https://kody.dev',
		token: createToken(),
		request: {
			packageIdOrKodyId: 'discord-gateway',
			exportName: 'dispatch-message-created',
			params: { content: 'hi' },
			idempotencyKey: 'evt-1',
			source: 'discord-gateway',
			topic: 'discord.message.created',
		},
	})
	const mismatch = await invokePackageExport({
		env: createEnv(db),
		baseUrl: 'https://kody.dev',
		token: createToken(),
		request: {
			packageIdOrKodyId: 'discord-gateway',
			exportName: 'dispatch-message-created',
			params: { content: 'different' },
			idempotencyKey: 'evt-1',
			source: 'discord-gateway',
			topic: 'discord.message.created',
		},
	})

	expect(mismatch.status).toBe(409)
	expect(mismatch.body).toEqual({
		ok: false,
		error: {
			code: 'idempotency_mismatch',
			message:
				'This idempotency key has already been used for a different package invocation request.',
		},
		idempotency: {
			key: 'evt-1',
			replayed: false,
		},
	})
	expect(repoMockModule.runBundledModuleWithRegistry).toHaveBeenCalledTimes(1)
})

test('invokePackageExport serializes execution failures without exposing thrown objects', async () => {
	const db = createDatabase()
	seedPackageResolution()
	repoMockModule.runBundledModuleWithRegistry.mockResolvedValue({
		error: new Error('Discord downstream failed'),
		logs: ['before-error'],
	})

	const response = await invokePackageExport({
		env: createEnv(db),
		baseUrl: 'https://kody.dev',
		token: createToken(),
		request: {
			packageIdOrKodyId: 'discord-gateway',
			exportName: 'dispatch-message-created',
			params: { content: 'hi' },
			idempotencyKey: 'evt-2',
			source: 'discord-gateway',
		},
	})

	expect(response.status).toBe(500)
	expect(response.body).toMatchObject({
		ok: false,
		error: {
			code: 'execution_failed',
			message: 'Discord downstream failed',
		},
		logs: ['before-error'],
	})
})

test('invokePackageExport stores export-not-found responses as terminal failures', async () => {
	const db = createDatabase()
	seedPackageResolution()

	const first = await invokePackageExport({
		env: createEnv(db),
		baseUrl: 'https://kody.dev',
		token: createToken({
			exportNames: ['./missing-export'],
		}),
		request: {
			packageIdOrKodyId: 'discord-gateway',
			exportName: 'missing-export',
			params: { content: 'hi' },
			idempotencyKey: 'evt-missing-export',
			source: 'discord-gateway',
		},
	})
	const second = await invokePackageExport({
		env: createEnv(db),
		baseUrl: 'https://kody.dev',
		token: createToken({
			exportNames: ['./missing-export'],
		}),
		request: {
			packageIdOrKodyId: 'discord-gateway',
			exportName: 'missing-export',
			params: { content: 'hi' },
			idempotencyKey: 'evt-missing-export',
			source: 'discord-gateway',
		},
	})

	expect(first.status).toBe(404)
	expect(first.body).toMatchObject({
		ok: false,
		error: {
			code: 'export_not_found',
		},
		idempotency: {
			key: 'evt-missing-export',
			replayed: false,
		},
	})
	expect(second.status).toBe(404)
	expect(second.body).toMatchObject({
		ok: false,
		error: {
			code: 'export_not_found',
		},
		idempotency: {
			key: 'evt-missing-export',
			replayed: true,
		},
	})
	expect(repoMockModule.runBundledModuleWithRegistry).not.toHaveBeenCalled()
})

test('invokePackageExport asks for republish when a published artifact is missing for npm-backed source', async () => {
	const db = createDatabase()
	seedPackageResolution()
	repoMockModule.loadPublishedBundleArtifactByIdentity.mockResolvedValue(null)
	repoMockModule.loadPackageSourceBySourceId.mockResolvedValue({
		source: {
			id: 'source-1',
			user_id: 'user-123',
			entity_kind: 'package',
			entity_id: 'pkg-1',
			repo_id: 'repo-1',
			published_commit: 'commit-1',
			indexed_commit: null,
			manifest_path: 'package.json',
			source_root: '/',
			created_at: '2026-04-27T00:00:00.000Z',
			updated_at: '2026-04-27T00:00:00.000Z',
		},
		manifest: {
			name: '@kentcdodds/discord-gateway',
			exports: {
				'./dispatch-message-created': './src/dispatch-message-created.ts',
			},
			kody: {
				id: 'discord-gateway',
				description: 'Discord gateway helpers',
			},
		},
		files: {
			'package.json': JSON.stringify({
				name: '@kentcdodds/discord-gateway',
				dependencies: {
					kleur: '^4.1.5',
				},
				exports: {
					'./dispatch-message-created': './src/dispatch-message-created.ts',
				},
				kody: {
					id: 'discord-gateway',
					description: 'Discord gateway helpers',
				},
			}),
			'src/dispatch-message-created.ts':
				'import kleur from "kleur"\nexport default async function run(){ return kleur.green("ok") }',
		},
	})

	const response = await invokePackageExport({
		env: createEnv(db),
		baseUrl: 'https://kody.dev',
		token: createToken(),
		request: {
			packageIdOrKodyId: 'discord-gateway',
			exportName: 'dispatch-message-created',
			params: { content: 'hi' },
			idempotencyKey: 'evt-republish-needed',
			source: 'discord-gateway',
		},
	})

	expect(response.status).toBe(500)
	expect(response.body).toMatchObject({
		ok: false,
		error: {
			code: 'invocation_failed',
			message: expect.stringContaining(
				'no published runtime bundle artifact is available yet',
			),
		},
	})
	expect(
		repoMockModule.typecheckPackageEntrypointsFromSourceFiles,
	).toHaveBeenCalledWith({
		sourceFiles: expect.objectContaining({
			'package.json': expect.any(String),
			'src/dispatch-message-created.ts': expect.any(String),
		}),
		entryPoints: [
			{
				path: 'src/dispatch-message-created.ts',
				includeStorage: true,
			},
		],
		emittedEventTopics: [],
	})
	expect(repoMockModule.persistPublishedBundleArtifact).not.toHaveBeenCalled()
	expect(repoMockModule.runBundledModuleWithRegistry).not.toHaveBeenCalled()
})

test('invokePackageSubscription uses the normal capability registry with package storage and source metadata intact', async () => {
	const db = createDatabase()
	seedPackageResolution()
	repoMockModule.loadPackageManifestBySourceId.mockResolvedValue({
		source: {
			id: 'source-1',
			user_id: 'user-123',
			entity_kind: 'package',
			entity_id: 'pkg-1',
			repo_id: 'repo-1',
			published_commit: 'commit-1',
			indexed_commit: null,
			manifest_path: 'package.json',
			source_root: '/',
			created_at: '2026-04-27T00:00:00.000Z',
			updated_at: '2026-04-27T00:00:00.000Z',
		},
		manifest: {
			name: '@kentcdodds/discord-gateway',
			exports: {
				'./dispatch-message-created': './src/dispatch-message-created.ts',
			},
			kody: {
				id: 'discord-gateway',
				description: 'Discord gateway helpers',
				app: {
					entry: './src/app.ts',
				},
				subscriptions: {
					'email.message.received': {
						handler: './src/email-message-received.ts',
					},
				},
			},
		},
	})
	repoMockModule.loadPublishedBundleArtifactByIdentity.mockResolvedValue({
		row: {
			id: 'artifact-subscription-1',
		},
		artifact: {
			version: 1,
			kind: 'module',
			artifactName: 'subscription:email.message.received',
			sourceId: 'source-1',
			publishedCommit: 'commit-1',
			entryPoint: 'src/email-message-received.ts',
			mainModule: 'dist/subscription.js',
			modules: {
				'dist/subscription.js':
					'export default async function run(){ return { ok: true } }',
			},
			dependencies: [],
			packageContext: {
				packageId: 'pkg-1',
				kodyId: 'discord-gateway',
				sourceId: 'source-1',
			},
			serviceContext: null,
			createdAt: '2026-04-27T00:00:00.000Z',
		},
	})
	repoMockModule.runBundledModuleWithRegistry.mockResolvedValue({
		result: { ok: true },
		logs: [],
	})

	const savedPackage = {
		id: 'pkg-1',
		userId: 'user-123',
		name: '@kentcdodds/discord-gateway',
		kodyId: 'discord-gateway',
		description: 'Discord gateway helpers',
		tags: [],
		searchText: null,
		sourceId: 'source-1',
		hasApp: true,
		createdAt: '2026-04-27T00:00:00.000Z',
		updatedAt: '2026-04-27T00:00:00.000Z',
	}

	const response = await invokePackageSubscription({
		env: createEnv(db),
		baseUrl: 'https://kody.dev',
		savedPackage,
		topic: 'email.message.received',
		params: {
			event: 'email.message.received',
			message: { id: 'message-123' },
		},
		idempotencyKey: 'email:message-123:pkg-1:email.message.received',
		source: 'email',
	})

	expect(response.status).toBe(200)
	expect(repoMockModule.runBundledModuleWithRegistry).toHaveBeenCalledTimes(1)
	expect(repoMockModule.runBundledModuleWithRegistry).toHaveBeenCalledWith(
		expect.anything(),
		expect.objectContaining({
			baseUrl: 'https://kody.dev',
			user: expect.objectContaining({
				userId: 'user-123',
				displayName: 'package:discord-gateway',
			}),
			storageContext: {
				sessionId: null,
				appId: 'pkg-1',
				storageId: 'package:pkg-1',
			},
			repoContext: expect.objectContaining({
				sourceId: 'source-1',
			}),
		}),
		expect.anything(),
		{
			event: 'email.message.received',
			message: { id: 'message-123' },
		},
		expect.objectContaining({
			storageTools: {
				userId: 'user-123',
				storageId: 'package:pkg-1',
				writable: true,
			},
			packageContext: {
				packageId: 'pkg-1',
				kodyId: 'discord-gateway',
				sourceId: 'source-1',
			},
		}),
	)
	const runOptions =
		repoMockModule.runBundledModuleWithRegistry.mock.calls[0]?.[4]
	expect(runOptions).toBeDefined()
	expect(
		(runOptions as { skipCapabilityRegistry?: boolean }).skipCapabilityRegistry,
	).toBeUndefined()
})
