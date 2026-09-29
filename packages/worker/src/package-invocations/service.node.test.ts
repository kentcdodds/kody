import { expect, test, vi } from 'vitest'
import {
	AccountSuspendedError,
	accountSuspendedMessage,
} from '#worker/account/account-suspension.ts'
import * as runRecords from '#worker/run-records/service.ts'
import {
	consoleError,
	consoleWarn,
} from '#worker/test-support/console-spies.ts'
import { invokePackageExport, invokePackageSubscription } from './service.ts'
import { clearInvokeContractCachesForTests } from './invoke-contract-cache.ts'
import { maxStoredInvocationResponseJsonBytes } from './repo.ts'
import {
	packageInvocationsRepoMockModule as repoMockModule,
	createDatabase,
	createEnv,
	createToken,
	seedPackageResolution,
	seedRuntimeDispatchPackages,
	createRuntimeDispatchTools,
} from '#worker/test-support/package-invocations.ts'

vi.mock('#worker/package-registry/repo.ts', () => ({
	getSavedPackageById: (...args: Array<unknown>) =>
		repoMockModule.getSavedPackageById(...args),
	getSavedPackageByKodyId: (...args: Array<unknown>) =>
		repoMockModule.getSavedPackageByKodyId(...args),
	getSavedPackageByName: (...args: Array<unknown>) =>
		repoMockModule.getSavedPackageByName(...args),
	listSavedPackagesByUserId: (...args: Array<unknown>) =>
		repoMockModule.listSavedPackagesByUserId(...args),
}))

vi.mock('#worker/package-registry/source.ts', () => ({
	loadPackageManifestBySourceId: (...args: Array<unknown>) =>
		repoMockModule.loadPackageManifestBySourceId(...args),
	loadPackageSourceBySourceId: (...args: Array<unknown>) =>
		repoMockModule.loadPackageSourceBySourceId(...args),
	loadPackageSourceRowForUser: (...args: Array<unknown>) =>
		repoMockModule.loadPackageSourceRowForUser(...args),
	loadPackageManifestForSource: (...args: Array<unknown>) =>
		repoMockModule.loadPackageManifestForSource(...args),
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

vi.mock('#mcp/run-kody-registry.ts', () => ({
	runBundledModuleWithRegistry: (...args: Array<unknown>) =>
		repoMockModule.runBundledModuleWithRegistry(...args),
}))

vi.mock('#worker/usage/agent-package-conversation-uses.ts', () => ({
	recordAgentPackageConversationUse: (...args: Array<unknown>) =>
		repoMockModule.recordAgentPackageConversationUse(...args),
}))

vi.mock('#worker/run-records/package-subscriptions.ts', () => ({
	dispatchRunErrorSubscriptionEvents: (...args: Array<unknown>) =>
		repoMockModule.dispatchRunErrorSubscriptionEvents(...args),
}))

const backgroundUserMocks = vi.hoisted(() => ({
	resolveBackgroundMcpUser: vi.fn(async (_db: D1Database, userId: string) => ({
		userId,
		email: 'owner@example.com',
		username: 'owner',
		displayName: 'Owner',
	})),
}))

vi.mock('#worker/identity/background-mcp-user.ts', () => ({
	resolveBackgroundMcpUser: (db: D1Database, userId: string) =>
		backgroundUserMocks.resolveBackgroundMcpUser(db, userId),
}))

type ExportRequest = Parameters<typeof invokePackageExport>[0]['request']
type Db = ReturnType<typeof createDatabase>

const runMock = repoMockModule.runBundledModuleWithRegistry
const fromDiscord = {
	source: 'discord-gateway',
	topic: 'discord.message.created',
}
const packageContext = {
	packageId: 'pkg-1',
	kodyId: 'discord-gateway',
	sourceId: 'source-1',
}
const source1 = {
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
}

function dispatchRequest(
	idempotencyKey: string,
	overrides: Partial<ExportRequest> = {},
): ExportRequest {
	return {
		packageIdOrKodyId: 'discord-gateway',
		exportName: 'dispatch-message-created',
		params: { content: 'hi' },
		idempotencyKey,
		...overrides,
	}
}

function invoke(
	db: Db,
	request: ExportRequest,
	token: ReturnType<typeof createToken> = createToken(),
	signal?: AbortSignal,
) {
	return invokePackageExport({
		env: createEnv(db),
		baseUrl: 'https://kody.dev',
		token,
		request,
		signal,
	})
}

function runOptionsAt(index: number) {
	return runMock.mock.calls[index]?.[4] as
		| {
				packageInvokeTools?: { invoke?: unknown }
				skipCapabilityRegistry?: boolean
				storageTools?: unknown
		  }
		| undefined
}

/**
 * Invokes with a caller signal, lets the sandbox start, then disconnects.
 * `onEnter` runs inside the sandbox before it blocks on the abort.
 */
async function invokeAndDisconnect(
	db: Db,
	request: ExportRequest,
	onEnter: () => void = () => {},
) {
	const controller = new AbortController()
	let sandboxEntered = false
	runMock.mockImplementation(
		async (
			_env: unknown,
			_caller: unknown,
			_bundle: unknown,
			_params: unknown,
			options: { signal?: AbortSignal } | undefined,
		) => {
			sandboxEntered = true
			onEnter()
			const signal = options?.signal
			await new Promise((_resolve, reject) => {
				if (!signal) {
					reject(new Error('expected the caller abort signal'))
					return
				}
				if (signal.aborted) {
					reject(signal.reason)
					return
				}
				signal.addEventListener('abort', () => reject(signal.reason), {
					once: true,
				})
			})
			return { result: { late: true }, logs: ['should-not-win'] }
		},
	)
	const pending = invoke(db, request, createToken(), controller.signal)
	await vi.waitFor(() => {
		expect(sandboxEntered).toBe(true)
	})
	controller.abort()
	return await pending
}

test('invokePackageExport executes a scoped package export successfully', async () => {
	const db = createDatabase()
	seedPackageResolution()
	runMock.mockResolvedValue({
		result: { reply: 'hello discord' },
		logs: ['dispatched'],
	})

	const response = await invoke(
		db,
		dispatchRequest('evt-1', { topic: 'discord.message.created' }),
	)

	expect(response.status).toBe(200)
	expect(response.body).toMatchObject({
		ok: true,
		exportName: './dispatch-message-created',
		idempotency: { key: 'evt-1', replayed: false },
		result: { reply: 'hello discord' },
		logs: ['dispatched'],
	})
	expect(runMock).toHaveBeenCalledTimes(1)
	expect(runOptionsAt(0)).toMatchObject({ packageContext })
	expect(runOptionsAt(0)?.packageInvokeTools?.invoke).toEqual(
		expect.any(Function),
	)
})

test('suspended owners are refused before package code loads, cannot replay stored responses, and the denial is not stored', async () => {
	const db = createDatabase()
	seedPackageResolution()
	runMock.mockResolvedValue({
		result: { reply: 'stored before suspension' },
		logs: [],
	})
	const suspendNextCall = () =>
		backgroundUserMocks.resolveBackgroundMcpUser.mockRejectedValueOnce(
			new AccountSuspendedError(),
		)

	suspendNextCall()
	const refused = await invoke(
		db,
		dispatchRequest('evt-suspended', { topic: 'discord.message.created' }),
	)
	expect(refused.status).toBe(403)
	expect(refused.body).toMatchObject({
		ok: false,
		error: { code: 'account_suspended', message: accountSuspendedMessage },
	})
	expect(
		repoMockModule.loadPublishedBundleArtifactByIdentity,
	).not.toHaveBeenCalled()
	expect(runMock).not.toHaveBeenCalled()

	const request = dispatchRequest('evt-replay-while-suspended', {
		topic: 'discord.message.created',
	})
	expect((await invoke(db, request)).status).toBe(200)

	suspendNextCall()
	const whileSuspended = await invoke(db, request)
	expect(whileSuspended.status).toBe(403)
	expect(whileSuspended.body).toMatchObject({
		ok: false,
		error: { code: 'account_suspended' },
	})
	expect(JSON.stringify(whileSuspended.body)).not.toContain(
		'stored before suspension',
	)

	const afterUnsuspend = await invoke(db, request)
	expect(afterUnsuspend.status).toBe(200)
	expect(afterUnsuspend.body).toMatchObject({
		ok: true,
		idempotency: { replayed: true },
		result: { reply: 'stored before suspension' },
	})
	expect(runMock).toHaveBeenCalledTimes(1)
})

test('package runtime can dynamically invoke the current published export from another package', async () => {
	const db = createDatabase()
	seedRuntimeDispatchPackages()
	let subscriberVersion = 'v1'
	runMock.mockImplementation(
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
						specifier: 'kody:@kentcdodds/discord-general-chat',
						options: {
							exportName: './handle-discord-message-created',
							params: { event: params?.event },
						},
					}),
					logs: [],
				}
			}
			if (bundle.mainModule === 'dist/subscriber.js') {
				return {
					result: { version: subscriberVersion, eventId: params?.event?.id },
					logs: [],
				}
			}
			throw new Error(`Unexpected bundle ${bundle.mainModule}`)
		},
	)
	const gatewayToken = createToken({ packageId: 'pkg-gateway' })
	const dispatch = (messageId: string) =>
		invoke(
			db,
			dispatchRequest(`gateway-${messageId}`, {
				exportName: './dispatch-message-created',
				params: { event: { id: messageId } },
			}),
			gatewayToken,
		)

	const first = await dispatch('message-1')
	subscriberVersion = 'v2'
	const second = await dispatch('message-2')

	expect(first).toMatchObject({
		status: 200,
		body: { ok: true, result: { version: 'v1', eventId: 'message-1' } },
	})
	expect(second).toMatchObject({
		status: 200,
		body: { ok: true, result: { version: 'v2', eventId: 'message-2' } },
	})
	expect(runMock).toHaveBeenCalledTimes(4)
	expect(runOptionsAt(0)?.packageInvokeTools?.invoke).toEqual(
		expect.any(Function),
	)
	expect(runOptionsAt(1)).toMatchObject({
		packageContext: {
			packageId: 'pkg-subscriber',
			kodyId: 'discord-general-chat',
			sourceId: 'source-subscriber',
		},
	})
	expect(runOptionsAt(1)?.packageInvokeTools?.invoke).toEqual(
		expect.any(Function),
	)
})

test('packages.invoke is lean when key-less and exactly-once when keyed', async () => {
	const db = createDatabase()
	seedRuntimeDispatchPackages()
	let executionCount = 0
	runMock.mockImplementation(async () => {
		executionCount += 1
		return { result: { handled: true, executionCount }, logs: [] }
	})
	const tools = createRuntimeDispatchTools(db)
	const request = (idempotencyKey?: string) => ({
		specifier: 'kody:@kentcdodds/discord-general-chat' as const,
		options: {
			exportName: './handle-discord-message-created',
			params: { event: { id: 'message-1' } },
			...(idempotencyKey ? { idempotencyKey } : {}),
		},
	})

	// Ephemeral semantics: identical key-less calls execute independently.
	expect(await tools.invoke(request())).toEqual({
		handled: true,
		executionCount: 1,
	})
	expect(await tools.invoke(request())).toEqual({
		handled: true,
		executionCount: 2,
	})
	expect(runMock).toHaveBeenCalledTimes(2)
	// No ledger row exists, so the run record carries neither an invocation id
	// nor an idempotency key (which downgrades it to on-failure persistence).
	expect(runOptionsAt(0)).toMatchObject({
		runRecord: { surface: 'export', invocationId: null, idempotencyKey: null },
	})
	expect(db.runLog.ledgerRows).toEqual([])

	expect(await tools.invoke(request('evt-keyed-1'))).toEqual({
		handled: true,
		executionCount: 3,
	})
	expect(await tools.invoke(request('evt-keyed-1'))).toEqual({
		handled: true,
		executionCount: 3,
	})
	expect(runMock).toHaveBeenCalledTimes(3)
	// The keyed path owns its run record (claimed together with the ledger
	// row in one DO call), so the registry must not open a second one.
	expect(runOptionsAt(2)).toMatchObject({
		runRecord: null,
		runSurface: 'export',
	})
	const ledgerRow = db.runLog.ledgerRows.find(
		(row) => row.idempotencyKey === 'evt-keyed-1',
	)
	expect(ledgerRow).toMatchObject({ status: 'completed' })
	expect(
		[...db.runLog.runRows.values()].find(
			(row) => row['idempotencyKey'] === 'evt-keyed-1',
		),
	).toMatchObject({
		surface: 'export',
		status: 'success',
		invocationId: ledgerRow?.id,
		idempotencyKey: 'evt-keyed-1',
	})
})

test('invokePackageExport enforces idempotency replay, mismatch, corruption, and persistence failures', async () => {
	const db = createDatabase()
	seedPackageResolution()
	runMock.mockResolvedValue({
		result: { reply: 'hello discord' },
		logs: ['dispatched'],
	})
	const replayRequest = dispatchRequest('evt-replay', fromDiscord)

	expect((await invoke(db, replayRequest)).status).toBe(200)
	const replaySecond = await invoke(db, replayRequest)
	expect(replaySecond.status).toBe(200)
	expect(replaySecond.body).toMatchObject({
		ok: true,
		idempotency: { key: 'evt-replay', replayed: true },
	})

	await invoke(db, dispatchRequest('evt-mismatch', fromDiscord))
	const mismatch = await invoke(
		db,
		dispatchRequest('evt-mismatch', {
			...fromDiscord,
			params: { content: 'different' },
		}),
	)
	expect(mismatch.status).toBe(409)
	expect(mismatch.body).toEqual({
		ok: false,
		error: {
			code: 'idempotency_mismatch',
			message:
				'This idempotency key has already been used for a different package invocation request.',
		},
		idempotency: { key: 'evt-mismatch', replayed: false },
	})

	const ignoreCallsBefore = runMock.mock.calls.length
	const ignoreParamsHash = (params: Record<string, unknown>) =>
		dispatchRequest('evt-delivery-ignore', {
			...fromDiscord,
			params,
			idempotencyParamsHash: 'ignore',
		})
	const ignoreFirst = await invoke(
		db,
		ignoreParamsHash({
			content: 'hi',
			receivedAt: '2026-01-01T00:00:00.000Z',
		}),
	)
	const ignoreReplay = await invoke(
		db,
		ignoreParamsHash({
			content: 'different',
			receivedAt: '2026-01-01T00:00:01.000Z',
		}),
	)
	expect(ignoreFirst.status).toBe(200)
	expect(ignoreReplay.status).toBe(200)
	expect(ignoreReplay.body).toEqual(ignoreFirst.body)
	expect(ignoreReplay.body).not.toMatchObject({
		idempotency: { replayed: true },
	})
	expect(runMock.mock.calls.length).toBe(ignoreCallsBefore + 1)

	const corruptRequest = dispatchRequest('evt-corrupt', fromDiscord)
	expect((await invoke(db, corruptRequest)).status).toBe(200)
	db.runLog.corruptStoredResponses()
	const corruptSecond = await invoke(db, corruptRequest)
	expect(corruptSecond.status).toBe(409)
	expect(corruptSecond.body).toMatchObject({
		ok: false,
		error: { code: 'idempotency_response_unavailable' },
		idempotency: { key: 'evt-corrupt', replayed: false },
	})
	expect(runMock).toHaveBeenCalledTimes(4)

	const failingDb = createDatabase({ failClaim: true })
	seedPackageResolution()
	consoleError.mockImplementation(() => {})
	const persistenceFailure = await invoke(
		failingDb,
		dispatchRequest('evt-insert-failure', fromDiscord),
	)
	expect(persistenceFailure.status).toBe(500)
	expect(persistenceFailure.body).toMatchObject({
		ok: false,
		error: { code: 'idempotency_persistence_failed' },
		idempotency: { key: 'evt-insert-failure', replayed: false },
	})
	expect(consoleError).toHaveBeenCalledWith(
		'package invocation idempotency persistence failed',
		expect.any(Error),
	)
})

test('completed keyed invocation reports terminal persistence failure instead of false success', async () => {
	consoleError.mockImplementation(() => {})
	const db = createDatabase({ failFinish: true })
	seedPackageResolution()
	runMock.mockResolvedValue({ result: { handled: true }, logs: ['completed'] })
	const request = dispatchRequest('evt-finish-failure', {
		source: 'webhook',
		topic: 'webhook:discord-gateway:message',
	})

	expect(await invoke(db, request)).toMatchObject({
		status: 500,
		body: { ok: false, error: { code: 'idempotency_persistence_failed' } },
	})
	expect(await invoke(db, request)).toMatchObject({
		status: 409,
		body: { ok: false, error: { code: 'invocation_in_progress' } },
	})
	expect(runMock).toHaveBeenCalledTimes(1)
	expect(db.runLog.ledgerRows[0]?.status).toBe('in_progress')
	expect(consoleError).toHaveBeenCalledWith(
		'package invocation completed-result persistence failed',
		'RunLog finish unavailable',
	)
})

test('oversized terminal responses are not stored so backups stay restorable', async () => {
	const db = createDatabase()
	seedPackageResolution()
	runMock.mockResolvedValue({
		// Serialized response_json above maxStoredInvocationResponseJsonBytes.
		result: { blob: 'x'.repeat(maxStoredInvocationResponseJsonBytes + 1) },
		logs: [],
	})
	const request = dispatchRequest('evt-oversized', fromDiscord)

	// The first call still returns the live response in full.
	expect(await invoke(db, request)).toMatchObject({
		status: 200,
		body: { ok: true },
	})
	// The duplicate is deduplicated (no re-execution) but cannot replay the
	// dropped oversized response.
	const duplicate = await invoke(db, request)
	expect(duplicate.status).toBe(409)
	expect(duplicate.body).toMatchObject({
		ok: false,
		error: { code: 'idempotency_response_unavailable' },
		idempotency: { key: 'evt-oversized', replayed: false },
	})
	expect(runMock).toHaveBeenCalledTimes(1)
})

test('invokePackageExport records request source without gating auth', async () => {
	const db = createDatabase()
	seedPackageResolution()
	runMock.mockResolvedValue({
		result: { reply: 'hello trusted client' },
		logs: ['invoked'],
	})
	const anyExport = createToken({ exportNames: ['*'] })

	for (const source of ['personal-client', 'shortcuts']) {
		expect(
			await invoke(db, dispatchRequest(`evt-${source}`, { source }), anyExport),
		).toMatchObject({
			status: 200,
			body: {
				ok: true,
				exportName: './dispatch-message-created',
				source,
				result: { reply: 'hello trusted client' },
			},
		})
	}

	const unlabeled = await invoke(
		db,
		dispatchRequest('evt-unlabeled'),
		anyExport,
	)
	expect(unlabeled).toMatchObject({
		status: 200,
		body: { ok: true, result: { reply: 'hello trusted client' } },
	})
	expect(runMock).toHaveBeenCalledTimes(3)

	const scopedDeniedByExport = await invoke(
		db,
		dispatchRequest('evt-scoped-denied-export', { source: 'discord-gateway' }),
		createToken({ exportNames: ['./other-export'] }),
	)
	expect(scopedDeniedByExport).toMatchObject({
		status: 403,
		body: { ok: false, error: { code: 'export_not_allowed' } },
	})

	const deniedByPackage = await invoke(
		db,
		dispatchRequest('evt-wrong-package', { source: 'discord-gateway' }),
		createToken({ packageId: 'pkg-other', exportNames: ['*'] }),
	)
	expect(deniedByPackage).toMatchObject({
		status: 403,
		body: { ok: false, error: { code: 'package_not_allowed' } },
	})
})

test('invokePackageExport stores terminal failures for execution errors and missing exports', async () => {
	const db = createDatabase()
	seedPackageResolution()
	const fromGateway = { source: 'discord-gateway' }
	runMock.mockResolvedValue({
		error: new Error('Discord downstream failed'),
		logs: ['before-error'],
	})
	const executionFailure = await invoke(
		db,
		dispatchRequest('evt-2', fromGateway),
	)
	expect(executionFailure.status).toBe(500)
	expect(executionFailure.body).toMatchObject({
		ok: false,
		error: { code: 'execution_failed', message: 'Discord downstream failed' },
		logs: ['before-error'],
	})

	const resetCases: Array<[key: string, error: Error | string]> = [
		[
			'evt-do-reset',
			new Error('Durable Object reset because its code was updated.'),
		],
		[
			'evt-do-inactive-close',
			'Connection closed: this Durable Object instance is no longer active. Reconnect or retry the request.',
		],
	]
	for (const [key, error] of resetCases) {
		runMock.mockResolvedValue({ error, logs: [] })
		expect(await invoke(db, dispatchRequest(key, fromGateway))).toMatchObject({
			status: 503,
			body: {
				ok: false,
				error: {
					code: 'durable_object_reset',
					message: error instanceof Error ? error.message : error,
				},
			},
		})
	}

	runMock.mockClear()
	const missingExport = () =>
		invoke(
			db,
			dispatchRequest('evt-missing-export', {
				...fromGateway,
				exportName: 'missing-export',
			}),
			createToken({ exportNames: ['./missing-export'] }),
		)
	for (const replayed of [false, true]) {
		expect(await missingExport()).toMatchObject({
			status: 404,
			body: {
				ok: false,
				error: { code: 'export_not_found' },
				idempotency: { key: 'evt-missing-export', replayed },
			},
		})
	}
	expect(runMock).not.toHaveBeenCalled()
})

test('invokePackageExport asks for republish when a published artifact is missing for npm-backed source', async () => {
	const db = createDatabase()
	seedPackageResolution()
	repoMockModule.loadPublishedBundleArtifactByIdentity.mockResolvedValue(null)
	const manifest = {
		name: '@kentcdodds/discord-gateway',
		exports: {
			'./dispatch-message-created': './src/dispatch-message-created.ts',
		},
		kody: { id: 'discord-gateway', description: 'Discord gateway helpers' },
	}
	repoMockModule.loadPackageSourceBySourceId.mockResolvedValue({
		source: source1,
		manifest,
		files: {
			'package.json': JSON.stringify({
				...manifest,
				dependencies: { kleur: '^4.1.5' },
			}),
			'src/dispatch-message-created.ts':
				'import kleur from "kleur"\nexport default async function run(){ return kleur.green("ok") }',
		},
	})

	const response = await invoke(
		db,
		dispatchRequest('evt-republish-needed', { source: 'discord-gateway' }),
	)

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
		entryPoints: [{ path: 'src/dispatch-message-created.ts' }],
		emittedEventTopics: [],
	})
	expect(repoMockModule.persistPublishedBundleArtifact).not.toHaveBeenCalled()
	expect(runMock).not.toHaveBeenCalled()
})

test('invokePackageSubscription uses the normal capability registry with package storage and source metadata intact', async () => {
	const db = createDatabase()
	seedPackageResolution()
	repoMockModule.loadPackageManifestBySourceId.mockResolvedValue({
		source: source1,
		manifest: {
			name: '@kentcdodds/discord-gateway',
			exports: {
				'./dispatch-message-created': './src/dispatch-message-created.ts',
			},
			kody: {
				id: 'discord-gateway',
				description: 'Discord gateway helpers',
				app: { entry: './src/app.ts' },
				subscriptions: {
					'email.message.received': {
						handler: './src/email-message-received.ts',
					},
				},
			},
		},
	})
	repoMockModule.loadPublishedBundleArtifactByIdentity.mockResolvedValue({
		row: { id: 'artifact-subscription-1', publishedCommit: 'commit-1' },
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
			packageContext,
			createdAt: '2026-04-27T00:00:00.000Z',
		},
	})
	runMock.mockResolvedValue({ result: { ok: true }, logs: [] })

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
		hidden: false,
		isPrivate: false,
		createdAt: '2026-04-27T00:00:00.000Z',
		updatedAt: '2026-04-27T00:00:00.000Z',
	}
	const params = {
		event: 'email.message.received',
		message: { id: 'message-123' },
	}
	const deliver = (messageId: string) =>
		invokePackageSubscription({
			env: createEnv(db),
			baseUrl: 'https://kody.dev',
			savedPackage,
			topic: 'email.message.received',
			params,
			idempotencyKey: `email:${messageId}:pkg-1:email.message.received`,
			source: 'email',
		})

	expect((await deliver('message-123')).status).toBe(200)
	expect(runMock).toHaveBeenCalledTimes(1)
	expect(runMock).toHaveBeenCalledWith(
		expect.anything(),
		expect.objectContaining({
			baseUrl: 'https://kody.dev',
			user: expect.objectContaining({
				userId: 'user-123',
				email: 'owner@example.com',
				displayName: 'Owner',
			}),
			storageContext: {
				sessionId: null,
				appId: 'pkg-1',
				packageId: 'pkg-1',
				storageId: 'package:pkg-1',
			},
			repoContext: expect.objectContaining({ sourceId: 'source-1' }),
		}),
		expect.anything(),
		params,
		expect.objectContaining({ packageContext }),
	)
	const runOptions = runOptionsAt(0)
	expect(runOptions).toMatchObject({ runSurface: 'subscription' })
	expect(runOptions?.skipCapabilityRegistry).toBeUndefined()
	// Package invocation runs no longer bind ambient `storage`: the package
	// bucket is reached via packageStorage(), granted through packageContext.
	expect(runOptions?.storageTools).toBeUndefined()

	db.runLog.seedStaleInvocation(
		'email:message-stale:pkg-1:email.message.received',
	)
	expect((await deliver('message-stale')).status).toBe(200)
	expect(runMock).toHaveBeenCalledTimes(2)

	const freshKey = 'email:message-fresh:pkg-1:email.message.received'
	db.runLog.seedFreshInvocation(freshKey)
	const completionTimer = setTimeout(() => {
		db.runLog.completeInvocation(freshKey)
	}, 150)
	try {
		expect((await deliver('message-fresh')).status).toBe(200)
		expect(runMock).toHaveBeenCalledTimes(2)
	} finally {
		clearTimeout(completionTimer)
	}

	// The commit-keyed artifact cache is warm from the invocations above and
	// would absorb the injected KV failure; this scenario is about a cold
	// artifact load failing transiently.
	clearInvokeContractCachesForTests()
	repoMockModule.loadPublishedBundleArtifactByIdentity.mockRejectedValueOnce(
		new Error('KV timeout'),
	)
	expect(await deliver('message-transient')).toMatchObject({
		status: 503,
		body: { error: { code: 'artifact_preparation_failed' } },
	})
	expect((await deliver('message-transient')).status).toBe(200)
})

test('caller disconnect finishes a keyed package invocation instead of leaving it running', async () => {
	const db = createDatabase()
	seedPackageResolution()
	const hasStartedLog = () =>
		[...db.runLog.runLogs.values()].some((lines) =>
			lines.some((line) => line.startsWith('package invocation started:')),
		)
	let sawStartedLogWhileRunning = false
	const request = dispatchRequest('audit-listupcoming')

	const response = await invokeAndDisconnect(db, request, () => {
		sawStartedLogWhileRunning = hasStartedLog()
	})

	expect(sawStartedLogWhileRunning).toBe(true)
	expect(response.status).toBe(408)
	expect(response.body).toMatchObject({
		ok: false,
		error: { code: 'client_disconnected' },
		idempotency: { key: 'audit-listupcoming', replayed: false },
	})
	expect(hasStartedLog()).toBe(true)
	expect(
		[...db.runLog.runRows.values()].some(
			(row) =>
				row['status'] === 'error' && row['errorName'] === 'client_disconnected',
		),
	).toBe(true)
	expect(runMock).toHaveBeenCalledTimes(1)

	const replay = await invoke(db, request)
	expect(replay.status).toBe(408)
	expect(replay.body).toMatchObject({
		ok: false,
		error: { code: 'client_disconnected' },
		idempotency: { key: 'audit-listupcoming', replayed: true },
	})
	expect(runMock).toHaveBeenCalledTimes(1)
})

test('disconnect finish failure still allows a terminal ledger finish', async () => {
	consoleWarn.mockImplementation(() => {})
	const db = createDatabase()
	seedPackageResolution()
	const realFinish = runRecords.finishPackageInvocationRecord
	const finishSpy = vi
		.spyOn(runRecords, 'finishPackageInvocationRecord')
		.mockImplementationOnce(async () => {
			throw new Error('transient disconnect finish failure')
		})
		.mockImplementation((...args) => realFinish(...args))

	try {
		const response = await invokeAndDisconnect(
			db,
			dispatchRequest('disconnect-finish-fail'),
		)
		expect(response.status).not.toBe(408)
		expect(
			[...db.runLog.runRows.values()].some(
				(row) => row['status'] === 'error' || row['status'] === 'success',
			),
		).toBe(true)
		expect(
			db.runLog.ledgerRows.some(
				(row) =>
					row.idempotencyKey === 'disconnect-finish-fail' &&
					row.status !== 'in_progress',
			),
		).toBe(true)
		expect(finishSpy.mock.calls.length).toBeGreaterThanOrEqual(2)
		expect(consoleWarn).toHaveBeenCalledWith(
			'package invocation disconnect finish failed',
			'transient disconnect finish failure',
		)
	} finally {
		finishSpy.mockRestore()
		consoleWarn.mockReset()
	}
})

test('disconnect finish fence loss returns the durable ledger response', async () => {
	const db = createDatabase()
	seedPackageResolution()
	const realFinish = runRecords.finishPackageInvocationRecord
	const winnerBody = {
		ok: true,
		result: { winner: true },
		idempotency: { key: 'disconnect-fence-loss', replayed: false },
	}
	const finishSpy = vi
		.spyOn(runRecords, 'finishPackageInvocationRecord')
		.mockImplementationOnce(async (input) => {
			// Simulate a competing terminal write winning the fence first.
			await realFinish({
				...input,
				ledgerStatus: 'completed',
				responseJson: JSON.stringify({ status: 200, body: winnerBody }),
				status: 'success',
				result: { winner: true },
				error: undefined,
			})
			return realFinish(input)
		})
	const request = dispatchRequest('disconnect-fence-loss')
	const durableReplay = {
		status: 200,
		body: {
			ok: true,
			result: { winner: true },
			idempotency: { key: 'disconnect-fence-loss', replayed: true },
		},
	}

	try {
		expect(await invokeAndDisconnect(db, request)).toMatchObject(durableReplay)
		expect(await invoke(db, request)).toMatchObject(durableReplay)
		expect(runMock).toHaveBeenCalledTimes(1)
	} finally {
		finishSpy.mockRestore()
	}
})
