import { expect, test, vi } from 'vitest'
import { capabilityMap } from '#mcp/capabilities/registry.ts'
import { createMcpCallerContext } from '#mcp/context.ts'
import { errorFields, logMcpEvent } from '#mcp/observability.ts'

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

function resetRepoPersistenceMocks() {
	repoMockModule.ensureEntitySource.mockReset()
	repoMockModule.syncArtifactSourceSnapshot.mockReset()
	repoMockModule.ensureEntitySource.mockImplementation(
		async ({ id, userId, entityKind, entityId, sourceRoot }) => ({
			id:
				typeof id === 'string' && id.length > 0
					? id
					: `${entityKind}-${entityId}`,
			user_id: userId,
			entity_kind: entityKind,
			entity_id: entityId,
			repo_id: `${entityKind}-${entityId}`,
			published_commit: null,
			indexed_commit: null,
			manifest_path: entityKind === 'package' ? 'package.json' : 'kody.json',
			source_root: sourceRoot ?? '/',
			created_at: '2026-04-18T00:00:00.000Z',
			updated_at: '2026-04-18T00:00:00.000Z',
			bootstrapAccess: null,
		}),
	)
	repoMockModule.syncArtifactSourceSnapshot.mockResolvedValue(
		'published-commit-1',
	)
}

test('errorFields normalizes Error and non-Error values', () => {
	expect(errorFields(new TypeError('bad'))).toEqual({
		errorName: 'TypeError',
		errorMessage: 'bad',
	})
	expect(errorFields('plain')).toEqual({
		errorName: 'Unknown',
		errorMessage: 'plain',
	})
})

test('logMcpEvent writes mcp-event with JSON payload', () => {
	const originalInfo = console.info
	let tagArg: unknown
	let jsonArg: unknown
	console.info = ((tag: unknown, json?: unknown) => {
		tagArg = tag
		jsonArg = json
	}) as typeof console.info
	try {
		logMcpEvent({
			category: 'mcp',
			tool: 'search',
			toolName: 'search',
			outcome: 'success',
			durationMs: 42,
			baseUrl: 'https://example.com',
			hasUser: false,
		})
	} finally {
		console.info = originalInfo
	}

	expect(tagArg).toBe('mcp-event')
	expect(typeof jsonArg).toBe('string')
	const parsed = JSON.parse(jsonArg as string) as Record<string, unknown>
	expect(parsed.category).toBe('mcp')
	expect(parsed.tool).toBe('search')
	expect(parsed.outcome).toBe('success')
	expect(parsed.durationMs).toBe(42)
	expect(typeof parsed.timestamp).toBe('string')
})

test('logMcpEvent swallows failures from console.info', () => {
	const originalInfo = console.info
	const originalWarn = console.warn
	console.info = (() => {
		throw new Error('console boom')
	}) as typeof console.info
	let warnArgs: unknown
	console.warn = ((...args: unknown[]) => {
		warnArgs = args
	}) as typeof console.warn
	try {
		expect(() =>
			logMcpEvent({
				category: 'mcp',
				tool: 'search',
				toolName: 'search',
				outcome: 'success',
				durationMs: 1,
				baseUrl: 'https://example.com',
				hasUser: false,
			}),
		).not.toThrow()
		expect(Array.isArray(warnArgs) && warnArgs[0]).toBe('mcp-event-failed')
	} finally {
		console.info = originalInfo
		console.warn = originalWarn
	}
})

test('package_save capability logs parse_input failure and rethrows', async () => {
	const originalInfo = console.info
	const payloads: Array<string> = []
	console.info = ((tag: unknown, json?: unknown) => {
		if (tag === 'mcp-event' && typeof json === 'string') {
			payloads.push(json)
		}
	}) as typeof console.info
	try {
		const handler = capabilityMap['package_save'].handler
		await expect(
			handler(
				{},
				{
					env: {} as Env,
					callerContext: createMcpCallerContext({
						baseUrl: 'https://example.com',
					}),
				},
			),
		).rejects.toThrow()
	} finally {
		console.info = originalInfo
	}

	expect(payloads.length).toBe(1)
	const event = JSON.parse(payloads[0]!) as Record<string, unknown>
	expect(event.tool).toBe('capability')
	expect(event.capabilityName).toBe('package_save')
	expect(event.outcome).toBe('failure')
	expect(event.failurePhase).toBe('parse_input')
})

test('package_save rejects invalid package.json before persistence', async () => {
	const handler = capabilityMap['package_save'].handler
	await expect(
		handler(
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
			{
				env: {} as Env,
				callerContext: createMcpCallerContext({
					baseUrl: 'https://example.com',
					user: {
						userId: 'user-1',
						email: 'user@example.com',
					},
				}),
			},
		),
	).rejects.toThrow('Invalid package.json')
})

test('logMcpEvent reports failure without throwing when Sentry is off', () => {
	const originalInfo = console.info
	console.info = () => {}
	try {
		expect(() =>
			logMcpEvent({
				category: 'mcp',
				tool: 'search',
				toolName: 'search',
				outcome: 'failure',
				durationMs: 1,
				baseUrl: 'https://example.com',
				hasUser: false,
				sandboxError: true,
				errorName: 'Error',
				errorMessage: 'user code failed',
				cause: new Error('user code failed'),
			}),
		).not.toThrow()
	} finally {
		console.info = originalInfo
	}
})

test('package_save capability logs success for valid invocation', async () => {
	const originalInfo = console.info
	const payloads: Array<string> = []
	resetRepoPersistenceMocks()
	console.info = ((tag: unknown, json?: unknown) => {
		if (tag === 'mcp-event' && typeof json === 'string') {
			payloads.push(json)
		}
	}) as typeof console.info
	try {
		const handler = capabilityMap['package_save'].handler
		const result = await handler(
			{
				files: [
					{
						path: 'package.json',
						content: JSON.stringify({
							name: '@kody/observed-package',
							exports: {
								'.': './src/index.ts',
							},
							kody: {
								id: 'observed-package',
								description: 'Observation test package.',
								app: {
									entry: './src/app.ts',
								},
							},
						}),
					},
					{
						path: 'src/index.ts',
						content:
							'export default async function main() { return { ok: true } }\n',
					},
					{
						path: 'src/app.ts',
						content:
							'export default { async fetch() { return new Response("ok") } }\n',
					},
				],
			},
			{
				env: {
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
														name: '@kody/observed-package',
														kody_id: 'observed-package',
														description: 'Observation test package.',
														tags_json: '[]',
														search_text: null,
														source_id: 'package-package-1',
														has_app: 1,
														created_at: '2026-04-13T00:00:00.000Z',
														updated_at: '2026-04-13T00:00:00.000Z',
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
										'package.json': JSON.stringify({
											name: '@kody/observed-package',
											exports: { '.': './src/index.ts' },
											kody: {
												id: 'observed-package',
												description: 'Observation test package.',
												app: { entry: './src/app.ts' },
											},
										}),
										'src/index.ts':
											'export default async function main() { return { ok: true } }\n',
										'src/app.ts':
											'export default { async fetch() { return new Response("ok") } }\n',
									},
									createdAt: '2026-04-13T00:00:00.000Z',
								}
							}
							return null
						},
						put: async () => undefined,
						delete: async () => undefined,
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
									session_repo_id: 'repo-1',
									session_repo_name: 'repo-1',
									session_repo_namespace: 'default',
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
									content:
										path === 'package.json'
											? JSON.stringify({
													name: '@kody/observed-package',
													exports: { '.': './src/index.ts' },
													kody: {
														id: 'observed-package',
														description: 'Observation test package.',
														app: { entry: './src/app.ts' },
													},
												})
											: null,
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
				} as unknown as Env,
				callerContext: createMcpCallerContext({
					baseUrl: 'https://example.com',
					user: {
						userId: 'user-1',
						email: 'user@example.com',
					},
				}),
			},
		)
		expect(typeof (result as { package_id: string }).package_id).toBe('string')
		expect((result as { has_app: boolean }).has_app).toBe(true)
	} finally {
		console.info = originalInfo
	}

	expect(payloads.length).toBe(1)
	const event = JSON.parse(payloads[0]!) as Record<string, unknown>
	expect(event.outcome).toBe('success')
	expect(event.failurePhase).toBeUndefined()
}, 15_000)
