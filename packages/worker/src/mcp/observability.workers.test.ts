import { env } from 'cloudflare:workers'
import { expect, test, vi } from 'vitest'
import { McpCallerError } from '#mcp/caller-error.ts'
import { getStaticRegistry } from '#mcp/capabilities/registry.ts'
import { createMcpCallerContext } from '#mcp/context.ts'
import {
	callerContextFields,
	errorFields,
	logMcpEvent,
} from '#mcp/observability.ts'
import { consoleInfo, consoleWarn } from '#worker/test-support/console-spies.ts'
import { silenceIncidentalRuntimeWarnings } from '#worker/test-support/incidental-runtime-warnings.ts'

const repoMockModule = vi.hoisted(() => ({
	ensureEntitySource: vi.fn(),
	syncArtifactSourceSnapshot: vi.fn(),
}))

vi.mock('#worker/repo/source-service.ts', () => ({
	ensureEntitySource: (...args: Array<unknown>) =>
		repoMockModule.ensureEntitySource(...args),
}))

vi.mock('#worker/repo/source-sync.ts', () => ({
	syncArtifactSourceSnapshot: (...args: Array<unknown>) =>
		repoMockModule.syncArtifactSourceSnapshot(...args),
}))

function createTestEnv(overrides: Record<string, unknown> = {}) {
	return {
		USER_METER: env.USER_METER,
		...overrides,
	} as unknown as Env
}

function takeMcpEvents() {
	const events = consoleInfo.mock.calls
		.filter(([tag, json]) => tag === 'mcp-event' && typeof json === 'string')
		.map(([, json]) => JSON.parse(json as string) as Record<string, unknown>)
	consoleInfo.mockClear()
	return events
}

const searchSuccess = {
	category: 'mcp',
	tool: 'search',
	toolName: 'search',
	outcome: 'success',
	durationMs: 42,
	baseUrl: 'https://example.com',
	hasUser: false,
} as const

const observedPackageJson = JSON.stringify({
	name: '@user/observed-package',
	exports: { '.': './src/index.ts' },
	kody: {
		id: 'observed-package',
		description: 'Observation test package.',
		app: { entry: './src/app.ts' },
	},
})
const observedIndexSource =
	'export default async function main() { return { ok: true } }\n'
const observedAppSource =
	'export default { async fetch() { return new Response("ok") } }\n'

test('observability helpers normalize errors and emit resilient mcp-event logs', () => {
	expect(errorFields(new TypeError('bad'))).toEqual({
		errorName: 'TypeError',
		errorMessage: 'bad',
	})
	expect(errorFields('plain')).toEqual({
		errorName: 'Unknown',
		errorMessage: 'plain',
	})

	logMcpEvent(searchSuccess)
	expect(consoleInfo.mock.calls[0]?.[0]).toBe('mcp-event')
	expect(takeMcpEvents()).toEqual([
		expect.objectContaining({
			category: 'mcp',
			tool: 'search',
			outcome: 'success',
			durationMs: 42,
			timestamp: expect.any(String),
		}),
	])

	consoleInfo.mockImplementation(() => {
		throw new Error('console boom')
	})
	consoleWarn.mockImplementation(() => {})
	expect(() => logMcpEvent({ ...searchSuccess, durationMs: 1 })).not.toThrow()
	expect(consoleWarn.mock.calls[0]?.[0]).toBe('mcp-event-failed')

	consoleInfo.mockImplementation(() => {})
	expect(() =>
		logMcpEvent({
			...searchSuccess,
			outcome: 'failure',
			durationMs: 1,
			sandboxError: true,
			errorName: 'Error',
			errorMessage: 'user code failed',
			cause: new Error('user code failed'),
		}),
	).not.toThrow()
})

test('callerContextFields exposes the caller user id and logMcpEvent serializes it', () => {
	expect(
		callerContextFields(
			createMcpCallerContext({
				baseUrl: 'https://example.com',
				user: {
					userId: 'user-1',
					email: 'user@example.com',
					displayName: 'User One',
				},
			}),
		),
	).toMatchObject({
		baseUrl: 'https://example.com',
		hasUser: true,
		userId: 'user-1',
	})
	expect(
		callerContextFields(
			createMcpCallerContext({ baseUrl: 'https://example.com', user: null }),
		),
	).toMatchObject({ hasUser: false, userId: undefined })

	logMcpEvent({
		category: 'mcp',
		tool: 'capability',
		capabilityName: 'valueGet',
		outcome: 'success',
		durationMs: 5,
		baseUrl: 'https://example.com',
		hasUser: true,
		userId: 'user-1',
	})
	expect(takeMcpEvents()[0]?.userId).toBe('user-1')
})

test('packageSave logs parse failures, rejects invalid manifests, and logs successful saves', async () => {
	// The worker bundler emits an incidental experimental warning during the
	// successful save's artifact rebuild.
	silenceIncidentalRuntimeWarnings()
	const packageSave = (await getStaticRegistry()).capabilityMap['packageSave']
	if (!packageSave) throw new Error('Expected packageSave capability')
	const handler = packageSave.handler
	await expect(
		handler(
			{},
			{
				env: createTestEnv(),
				callerContext: createMcpCallerContext({
					baseUrl: 'https://example.com',
				}),
			},
		),
	).rejects.toThrow('Invalid input for capability "packageSave"')

	expect(takeMcpEvents()).toEqual([
		expect.objectContaining({
			tool: 'capability',
			capabilityName: 'packageSave',
			capabilitySource: 'builtin',
			outcome: 'failure',
			failurePhase: 'parse_input',
		}),
	])

	const userCallerContext = createMcpCallerContext({
		baseUrl: 'https://example.com',
		user: {
			userId: 'user-1',
			email: 'user@example.com',
			displayName: 'user',
		},
	})
	const signedInContext = {
		env: createTestEnv({
			APP_DB: {
				prepare() {
					return {
						bind() {
							return {
								first: async () => ({ username: 'user' }),
							}
						},
					}
				},
			},
		}),
		callerContext: userCallerContext,
	}

	const invalidManifest = handler(
		{
			files: [
				{
					path: 'package.json',
					content: JSON.stringify({
						name: 'pkg',
						kody: {
							id: 'pkg',
							description: 'missing exports',
						},
					}),
				},
			],
		},
		signedInContext,
	)
	await expect(invalidManifest).rejects.toThrow(McpCallerError)
	await expect(invalidManifest).rejects.toThrow('Invalid package.json')

	const wrongScope = handler(
		{
			files: [
				{
					path: 'package.json',
					content: JSON.stringify({
						name: '@other/observed-package',
						exports: {
							'.': './src/index.ts',
						},
						kody: {
							id: 'observed-package',
							description: 'Observation test package.',
						},
					}),
				},
				{ path: 'src/index.ts', content: observedIndexSource },
			],
		},
		signedInContext,
	)
	await expect(wrongScope).rejects.toThrow(McpCallerError)
	await expect(wrongScope).rejects.toThrow(
		'package.json name "@other/observed-package" must use the authenticated user\'s package scope "@user/*".',
	)
	expect(repoMockModule.ensureEntitySource).not.toHaveBeenCalled()

	takeMcpEvents()
	repoMockModule.ensureEntitySource.mockResolvedValue({
		id: 'package-package-1',
		user_id: 'user-1',
		entity_kind: 'package',
		entity_id: 'package-1',
		repo_id: 'package-package-1',
		published_commit: null,
		indexed_commit: null,
		manifest_path: 'package.json',
		source_root: '/',
		created_at: '2026-04-13T00:00:00.000Z',
		updated_at: '2026-04-13T00:00:00.000Z',
		bootstrapAccess: {
			defaultBranch: 'main',
			remote: 'https://example.com/artifacts/package-package-1.git',
			token: 'art_v1_bootstrap?expires=1760000000',
			expiresAt: '2026-06-06T00:00:00.000Z',
		},
	})
	repoMockModule.syncArtifactSourceSnapshot.mockResolvedValue(
		'published-commit-1',
	)
	const bundleArtifactsKvStore = new Map<string, string>()
	const result = await handler(
		{
			confirm_destructive_overwrite: true,
			files: [
				{ path: 'package.json', content: observedPackageJson },
				{ path: 'src/index.ts', content: observedIndexSource },
				{ path: 'src/app.ts', content: observedAppSource },
			],
		},
		{
			env: createTestEnv({
				APP_DB: {
					prepare(query: string) {
						return {
							bind() {
								return {
									first: async () =>
										query.includes('SELECT id, user_id') &&
										query.includes('FROM saved_packages')
											? {
													id: 'package-1',
													user_id: 'user-1',
													name: '@user/observed-package',
													kody_id: 'observed-package',
													description: 'Observation test package.',
													tags_json: '[]',
													search_text: null,
													source_id: 'package-package-1',
													has_app: 1,
													created_at: '2026-04-13T00:00:00.000Z',
													updated_at: '2026-04-13T00:00:00.000Z',
												}
											: query.includes('FROM users')
												? {
														username: 'user',
													}
												: query.includes('SELECT * FROM entity_sources')
													? {
															id: 'package-package-1',
															user_id: 'user-1',
															entity_kind: 'package',
															entity_id: 'package-1',
															repo_id: 'package-package-1',
															published_commit: 'published-commit-1',
															indexed_commit: 'published-commit-1',
															manifest_path: 'package.json',
															source_root: '/',
															created_at: '2026-04-13T00:00:00.000Z',
															updated_at: '2026-04-13T00:00:00.000Z',
														}
													: null,
									all: async () => ({
										results: [],
									}),
									run: async () => ({
										meta: { changes: 1 },
									}),
								}
							},
						}
					},
				},
				BUNDLE_ARTIFACTS_KV: {
					get: async (_key: string, type?: 'text' | 'json') => {
						if (type === 'json') {
							return {
								version: 1,
								sourceId: 'package-package-1',
								repoId: 'package-package-1',
								entityKind: 'package',
								entityId: 'package-1',
								publishedCommit: 'published-commit-1',
								manifestPath: 'package.json',
								sourceRoot: '/',
								files: {
									'package.json': observedPackageJson,
									'src/index.ts': observedIndexSource,
									'src/app.ts': observedAppSource,
								},
								createdAt: '2026-04-13T00:00:00.000Z',
							}
						}
						return null
					},
					put: async (key: string, value: string) => {
						bundleArtifactsKvStore.set(key, value)
					},
					delete: async (key: string) => {
						bundleArtifactsKvStore.delete(key)
					},
					list: async (options?: { prefix?: string; cursor?: string }) => ({
						keys: Array.from(bundleArtifactsKvStore.keys())
							.filter((key) => key.startsWith(options?.prefix ?? ''))
							.sort()
							.map((name) => ({ name })),
						list_complete: true,
						cursor: undefined,
					}),
				},
				CLOUDFLARE_ACCOUNT_ID: 'acct',
				CLOUDFLARE_API_TOKEN: 'token',
				CLOUDFLARE_API_BASE_URL: 'https://example.com',
				REPO_SESSION: {
					idFromName(name: string) {
						return name as unknown as DurableObjectId
					},
					get() {
						return {
							openSession: async () => ({
								id: 'session-1',
								source_id: 'source-package-1',
								base_commit: 'published-commit-1',
								source_root: '/',
								conversation_id: null,
								status: 'active',
								expires_at: null,
								last_checkpoint_at: null,
								last_checkpoint_commit: null,
								last_check_run_id: null,
								last_check_tree_hash: null,
								created_at: '2026-04-13T00:00:00.000Z',
								updated_at: '2026-04-13T00:00:00.000Z',
								published_commit: 'published-commit-1',
								manifest_path: 'package.json',
								entity_type: 'package',
							}),
							readFile: async ({ path }: { path: string }) => ({
								path,
								content: path === 'package.json' ? observedPackageJson : null,
							}),
							tree: async () => ({
								path: '/',
								name: '',
								type: 'directory',
								size: 0,
								children: [],
							}),
							discardSession: async () => ({
								ok: true,
								sessionId: 'session-1',
								deleted: true,
							}),
						}
					},
				},
				AI: {
					run: async () => ({
						data: [Array.from({ length: 384 }, () => 0)],
					}),
				},
			}),
			callerContext: userCallerContext,
		},
	)
	expect((result as { package_id: string }).package_id).toBeTruthy()
	expect((result as { has_app: boolean }).has_app).toBe(true)
	expect(repoMockModule.syncArtifactSourceSnapshot).toHaveBeenCalledWith(
		expect.objectContaining({
			sourceId: 'package-package-1',
			destructiveOverwriteConfirmed: true,
			bootstrapAccess: expect.objectContaining({
				remote: 'https://example.com/artifacts/package-package-1.git',
			}),
		}),
	)

	const [successEvent, ...rest] = takeMcpEvents()
	expect(rest).toEqual([])
	expect(successEvent?.outcome).toBe('success')
	expect(successEvent?.failurePhase).toBeUndefined()
}, 60_000)
