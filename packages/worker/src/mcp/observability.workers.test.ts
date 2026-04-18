import { expect, test } from 'vitest'
import { capabilityMap } from '#mcp/capabilities/registry.ts'
import { createMcpCallerContext } from '#mcp/context.ts'
import { errorFields, logMcpEvent } from '#mcp/observability.ts'

function createSavedAppPersistenceEnv(input: {
	appId: string
	vectorShouldFail?: boolean
	preloadApp?: boolean
}) {
	const entitySources = new Map<
		string,
		{
			id: string
			user_id: string
			entity_kind: string
			entity_id: string
			repo_id: string
			published_commit: string | null
			indexed_commit: string | null
			manifest_path: string
			source_root: string
			created_at: string
			updated_at: string
		}
	>()
	const uiArtifacts = new Map<
		string,
		{
			id: string
			user_id: string
			title: string
			description: string
			source_id: string | null
			client_code: string
			server_code: string | null
			server_code_id: string
			parameters: string | null
			hidden: number
			created_at: string
			updated_at: string
		}
	>()
	if (input.preloadApp) {
		uiArtifacts.set(input.appId, {
			id: input.appId,
			user_id: 'user-1',
			title: 'Observed app',
			description: 'Observation test app.',
			source_id: 'source-1',
			client_code: '<main><h1>Observed app</h1></main>',
			server_code: null,
			server_code_id: 'server-code-1',
			parameters: null,
			hidden: 0,
			created_at: '2026-04-13T00:00:00.000Z',
			updated_at: '2026-04-13T00:00:00.000Z',
		})
		entitySources.set('source-1', {
			id: 'source-1',
			user_id: 'user-1',
			entity_kind: 'app',
			entity_id: input.appId,
			repo_id: 'repo-1',
			published_commit: 'commit-bootstrap-1',
			indexed_commit: 'commit-bootstrap-1',
			manifest_path: 'kody.json',
			source_root: '/',
			created_at: '2026-04-13T00:00:00.000Z',
			updated_at: '2026-04-13T00:00:00.000Z',
		})
	}
	const sessionClient = {
		bootstrapSource: async () => ({
			sessionId: 'session-bootstrap',
			publishedCommit: 'commit-bootstrap-1',
			message: 'Bootstrapped source.',
		}),
		openSession: async () => ({
			id: 'session-open',
			source_id: 'source-1',
			source_root: '/',
			base_commit: 'commit-bootstrap-1',
			session_repo_id: 'session-repo-1',
			session_repo_name: 'session-repo-name',
			session_repo_namespace: 'default',
			conversation_id: null,
			last_checkpoint_commit: null,
			last_check_run_id: null,
			last_check_tree_hash: null,
			expires_at: null,
			created_at: '2026-04-13T00:00:00.000Z',
			updated_at: '2026-04-13T00:00:00.000Z',
			published_commit: 'commit-bootstrap-1',
			manifest_path: 'kody.json',
			entity_type: 'app' as const,
		}),
		applyEdits: async () => ({
			dryRun: false,
			totalChanged: 1,
			edits: [],
		}),
		publishSession: async () => ({
			status: 'ok' as const,
			sessionId: 'session-open',
			publishedCommit: 'commit-session-2',
			message: 'Published session.',
		}),
		discardSession: async () => ({
			ok: true as const,
			sessionId: 'session-open',
			deleted: true,
		}),
	}

	const db = {
		prepare(query: string) {
			return {
				bind(...params: Array<unknown>) {
					return {
						first: async () => {
							if (query.includes('FROM entity_sources WHERE id = ?')) {
								const sourceId = String(params[0])
								return entitySources.get(sourceId) ?? null
							}
							if (
								query.includes('FROM entity_sources') &&
								query.includes('WHERE user_id = ? AND entity_kind = ? AND entity_id = ?')
							) {
								const userId = String(params[0])
								const entityKind = String(params[1])
								const entityId = String(params[2])
								for (const row of entitySources.values()) {
									if (
										row.user_id === userId &&
										row.entity_kind === entityKind &&
										row.entity_id === entityId
									) {
										return row
									}
								}
								return null
							}
							if (
								query.includes('FROM ui_artifacts') &&
								query.includes('WHERE id = ? AND user_id = ?')
							) {
								const appId = String(params[0])
								const userId = String(params[1])
								const row = uiArtifacts.get(appId)
								return row?.user_id === userId ? row : null
							}
							return null
						},
						run: async () => {
							if (query.startsWith('INSERT INTO entity_sources')) {
								const row = {
									id: String(params[0]),
									user_id: String(params[1]),
									entity_kind: String(params[2]),
									entity_id: String(params[3]),
									repo_id: String(params[4]),
									published_commit:
										params[5] == null ? null : String(params[5]),
									indexed_commit:
										params[6] == null ? null : String(params[6]),
									manifest_path: String(params[7]),
									source_root: String(params[8]),
									created_at: String(params[9]),
									updated_at: String(params[10]),
								}
								entitySources.set(row.id, row)
								return { meta: { changes: 1 } }
							}
							if (query.startsWith('UPDATE entity_sources')) {
								const sourceId = String(params.at(-2))
								const userId = String(params.at(-1))
								const existing = entitySources.get(sourceId)
								if (!existing || existing.user_id !== userId) {
									return { meta: { changes: 0 } }
								}
								const next = { ...existing, updated_at: new Date().toISOString() }
								if (query.includes('published_commit = ?')) {
									next.published_commit =
										params[0] == null ? null : String(params[0])
								}
								if (query.includes('manifest_path = ?')) {
									next.manifest_path = String(
										params[query.includes('published_commit = ?') ? 1 : 0],
									)
								}
								if (query.includes('source_root = ?')) {
									next.source_root = String(
										params[
											query.includes('published_commit = ?') &&
											query.includes('manifest_path = ?')
												? 2
												: query.includes('published_commit = ?') ||
													 query.includes('manifest_path = ?')
													? 1
													: 0
										],
									)
								}
								entitySources.set(sourceId, next)
								return { meta: { changes: 1 } }
							}
							if (query.startsWith('INSERT INTO ui_artifacts')) {
								const row = {
									id: String(params[0]),
									user_id: String(params[1]),
									title: String(params[2]),
									description: String(params[3]),
									source_id: params[4] == null ? null : String(params[4]),
									client_code: String(params[5] ?? ''),
									server_code: params[6] == null ? null : String(params[6]),
									server_code_id: String(params[7]),
									parameters: params[8] == null ? null : String(params[8]),
									hidden: Number(params[9]),
									created_at: String(params[10]),
									updated_at: String(params[11]),
								}
								uiArtifacts.set(row.id, row)
								return { meta: { changes: 1 } }
							}
							if (query.startsWith('UPDATE ui_artifacts SET')) {
								const appId = String(params.at(-2))
								const userId = String(params.at(-1))
								const existing = uiArtifacts.get(appId)
								if (!existing || existing.user_id !== userId) {
									return { meta: { changes: 0 } }
								}
								const assignments = query
									.slice(query.indexOf('SET') + 3, query.indexOf('WHERE'))
									.split(',')
									.map((assignment) => assignment.trim().split(' = ')[0])
								const next = { ...existing }
								assignments.forEach((column, index) => {
									const value = params[index]
									switch (column) {
										case 'title':
											next.title = String(value)
											break
										case 'description':
											next.description = String(value)
											break
										case 'source_id':
											next.source_id = value == null ? null : String(value)
											break
										case 'client_code':
											next.client_code = value == null ? '' : String(value)
											break
										case 'server_code':
											next.server_code = value == null ? null : String(value)
											break
										case 'server_code_id':
											next.server_code_id = String(value)
											break
										case 'parameters':
											next.parameters = value == null ? null : String(value)
											break
										case 'hidden':
											next.hidden = Number(value)
											break
										case 'updated_at':
											next.updated_at = String(value)
											break
									}
								})
								uiArtifacts.set(appId, next)
								return { meta: { changes: 1 } }
							}
							return { meta: { changes: 1 } }
						},
					}
				},
			}
		},
	} as unknown as D1Database

	return {
		APP_DB: db,
		REPO_SESSION: {
			idFromName(name: string) {
				return name as unknown as DurableObjectId
			},
			get() {
				return sessionClient
			},
		},
		CLOUDFLARE_ACCOUNT_ID: 'account-1',
		CLOUDFLARE_API_TOKEN: 'token-1',
		CLOUDFLARE_API_BASE_URL: 'https://example.com',
		APP_RUNNER: {
			idFromName(name: string) {
				return name as unknown as DurableObjectId
			},
			get() {
				return {
					configure: async () => ({
						appId: input.appId,
						userId: 'user-1',
						baseUrl: 'https://example.com',
						facetNames: ['main'],
						serverCode: null,
						serverCodeId: crypto.randomUUID(),
						rateLimitPerMinute: 120,
						killSwitchEnabled: false,
						lastError: null,
					}),
				}
			},
		},
		...(input.vectorShouldFail
			? {
					CAPABILITY_VECTOR_INDEX: {
						upsert: async () => {
							throw new Error('vector refresh failed')
						},
					},
					AI: {
						run: async () => ({
							data: [Array.from({ length: 384 }, () => 0)],
						}),
					},
				}
			: {}),
	} as unknown as Env
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

test('ui_save_app capability logs parse_input failure and rethrows', async () => {
	const originalInfo = console.info
	const payloads: Array<string> = []
	console.info = ((tag: unknown, json?: unknown) => {
		if (tag === 'mcp-event' && typeof json === 'string') {
			payloads.push(json)
		}
	}) as typeof console.info
	try {
		const handler = capabilityMap['ui_save_app'].handler
		await expect(
			handler(
				{ title: 'Missing fields' },
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
	expect(event.capabilityName).toBe('ui_save_app')
	expect(event.outcome).toBe('failure')
	expect(event.failurePhase).toBe('parse_input')
})

test('ui_save_app rejects invalid serverCode before persistence', async () => {
	const handler = capabilityMap['ui_save_app'].handler
	await expect(
		handler(
			{
				title: 'Invalid server app',
				description: 'Should fail fast for invalid serverCode.',
				clientCode: '<main>Invalid server app</main>',
				serverCode: 'export const nope = 1',
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
	).rejects.toThrow('serverCode must export class App extends DurableObject')
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

test('ui_save_app capability logs success for valid invocation', async () => {
	const originalInfo = console.info
	const originalFetch = globalThis.fetch
	const payloads: Array<string> = []
	console.info = ((tag: unknown, json?: unknown) => {
		if (tag === 'mcp-event' && typeof json === 'string') {
			payloads.push(json)
		}
	}) as typeof console.info
	let repoCreated = false
	globalThis.fetch = (async (_input, init) => {
		const request = new Request('https://example.com/client/v4/mock', init)
		if (request.method === 'GET') {
			if (!repoCreated) {
				return new Response(
					JSON.stringify({
						success: false,
						errors: [{ code: 1000, message: 'missing repo' }],
						messages: [],
						result: null,
					}),
					{ status: 404, headers: { 'content-type': 'application/json' } },
				)
			}
			return new Response(
				JSON.stringify({
					success: true,
					errors: [],
					messages: [],
					result: {
						id: 'repo-1',
						name: 'repo-1',
						description: null,
						default_branch: 'main',
						created_at: '2026-04-13T00:00:00.000Z',
						updated_at: '2026-04-13T00:00:00.000Z',
						last_push_at: null,
						source: null,
						read_only: false,
						remote: 'https://artifacts.example/repo-1.git',
					},
				}),
				{ status: 200, headers: { 'content-type': 'application/json' } },
			)
		}
		repoCreated = true
		return new Response(
			JSON.stringify({
				success: true,
				errors: [],
				messages: [],
				result: {
					id: 'repo-1',
					name: 'repo-1',
					description: null,
					default_branch: 'main',
					remote: 'https://artifacts.example/repo-1.git',
					token: 'art_v1_test?expires=9999999999',
				},
			}),
			{ status: 200, headers: { 'content-type': 'application/json' } },
		)
	}) as typeof fetch
	try {
		const handler = capabilityMap['ui_save_app'].handler
		const result = await handler(
			{
				title: 'Observed app',
				description: 'Observation test app.',
				clientCode:
					'document.querySelector("#app")!.innerHTML = "<h1>Observed app</h1>"',
			},
			{
				env: createSavedAppPersistenceEnv({ appId: 'generated-app' }),
				callerContext: createMcpCallerContext({
					baseUrl: 'https://example.com',
					user: {
						userId: 'user-1',
						email: 'user@example.com',
					},
				}),
			},
		)
		expect(typeof (result as { app_id: string }).app_id).toBe('string')
		expect((result as { hidden: boolean }).hidden).toBe(true)
	} finally {
		console.info = originalInfo
		globalThis.fetch = originalFetch
	}

	expect(payloads.length).toBe(1)
	const event = JSON.parse(payloads[0]!) as Record<string, unknown>
	expect(event.outcome).toBe('success')
	expect(event.failurePhase).toBeUndefined()
})

test('ui_save_app logs vector refresh failure for in-place updates and still succeeds', async () => {
	const originalInfo = console.info
	const originalFetch = globalThis.fetch
	const payloads: Array<string> = []
	console.info = ((tag: unknown, json?: unknown) => {
		if (tag === 'mcp-event' && typeof json === 'string') {
			payloads.push(json)
		}
	}) as typeof console.info
	let repoCreated = false
	globalThis.fetch = (async (_input, init) => {
		const request = new Request('https://example.com/client/v4/mock', init)
		if (request.method === 'GET') {
			if (!repoCreated) {
				return new Response(
					JSON.stringify({
						success: false,
						errors: [{ code: 1000, message: 'missing repo' }],
						messages: [],
						result: null,
					}),
					{ status: 404, headers: { 'content-type': 'application/json' } },
				)
			}
			return new Response(
				JSON.stringify({
					success: true,
					errors: [],
					messages: [],
					result: {
						id: 'repo-1',
						name: 'repo-1',
						description: null,
						default_branch: 'main',
						created_at: '2026-04-13T00:00:00.000Z',
						updated_at: '2026-04-13T00:00:00.000Z',
						last_push_at: null,
						source: null,
						read_only: false,
						remote: 'https://artifacts.example/repo-1.git',
					},
				}),
				{ status: 200, headers: { 'content-type': 'application/json' } },
			)
		}
		repoCreated = true
		return new Response(
			JSON.stringify({
				success: true,
				errors: [],
				messages: [],
				result: {
					id: 'repo-1',
					name: 'repo-1',
					description: null,
					default_branch: 'main',
					remote: 'https://artifacts.example/repo-1.git',
					token: 'art_v1_test?expires=9999999999',
				},
			}),
			{ status: 200, headers: { 'content-type': 'application/json' } },
		)
	}) as typeof fetch
	try {
		const handler = capabilityMap['ui_save_app'].handler
		const result = await handler(
			{
				app_id: 'app-1',
				title: 'Observed app',
				description: 'Observation test app.',
				clientCode: '<main><h1>Observed app</h1></main>',
				hidden: false,
			},
			{
				env: createSavedAppPersistenceEnv({
					appId: 'app-1',
					preloadApp: true,
					vectorShouldFail: true,
				}),
				callerContext: createMcpCallerContext({
					baseUrl: 'https://example.com',
					user: {
						userId: 'user-1',
						email: 'user@example.com',
					},
				}),
			},
		)
		expect((result as { app_id: string }).app_id).toBe('app-1')
	} finally {
		console.info = originalInfo
		globalThis.fetch = originalFetch
	}

	expect(payloads.length).toBe(2)
	const driftEvent = JSON.parse(payloads[0]!) as Record<string, unknown>
	const driftContext = driftEvent.context as Record<string, unknown> | undefined
	expect(driftEvent.outcome).toBe('failure')
	expect(driftEvent.failurePhase).toBe('handler')
	expect(driftEvent.errorName).toBe('Error')
	expect(driftEvent.errorMessage).toBe('vector refresh failed')
	expect(driftEvent.message).toBe(
		'Failed to refresh saved app vector index after in-place update.',
	)
	expect(driftEvent.capabilityName).toBe('ui_save_app')
	expect(driftContext).toEqual({
		userId: 'user-1',
		appId: 'app-1',
		isUpdate: true,
	})

	const successEvent = JSON.parse(payloads[1]!) as Record<string, unknown>
	expect(successEvent.outcome).toBe('success')
	expect(successEvent.capabilityName).toBe('ui_save_app')
})
