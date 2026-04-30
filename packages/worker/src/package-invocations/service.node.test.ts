import { expect, test, vi } from 'vitest'
import { invokePackageExport } from './service.ts'

const repoMockModule = vi.hoisted(() => ({
	getSavedPackageById: vi.fn(),
	getSavedPackageByKodyId: vi.fn(),
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
		token: createToken(),
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

test('invokePackageExport replays responses created with the legacy exportName request hash key', async () => {
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
			idempotencyKey: 'evt-legacy-hash',
			source: 'discord-gateway',
			topic: 'discord.message.created',
		},
	})
	expect(first.status).toBe(200)

	const table = (
		db as unknown as {
			prepare: (query: string) => {
				bind: (...params: Array<unknown>) => {
					run: () => Promise<{ meta: { changes: number; last_row_id: number } }>
				}
			}
		}
	).prepare(
		`UPDATE package_invocations
		SET request_hash = ?, updated_at = ?
		WHERE user_id = ? AND token_id = ? AND package_id = ? AND export_name = ? AND idempotency_key = ?`,
	)
	const legacyDigest = await crypto.subtle.digest(
		'SHA-256',
		new TextEncoder().encode(
			JSON.stringify({
				exportName: './dispatch-message-created',
				packageId: 'pkg-1',
				params: { content: 'hi' },
				source: 'discord-gateway',
				topic: 'discord.message.created',
			}),
		),
	)
	const legacyHash = Array.from(new Uint8Array(legacyDigest))
		.map((value) => value.toString(16).padStart(2, '0'))
		.join('')
	await table
		.bind(
			legacyHash,
			'2026-04-27T00:00:00.000Z',
			'user-123',
			'discord-gateway',
			'pkg-1',
			'./dispatch-message-created',
			'evt-legacy-hash',
		)
		.run()

	const replay = await invokePackageExport({
		env: createEnv(db),
		baseUrl: 'https://kody.dev',
		token: createToken(),
		request: {
			packageIdOrKodyId: 'discord-gateway',
			exportName: 'dispatch-message-created',
			params: { content: 'hi' },
			idempotencyKey: 'evt-legacy-hash',
			source: 'discord-gateway',
			topic: 'discord.message.created',
		},
	})

	expect(replay.status).toBe(200)
	expect(replay.body).toMatchObject({
		ok: true,
		idempotency: {
			key: 'evt-legacy-hash',
			replayed: true,
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
