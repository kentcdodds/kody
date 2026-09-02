import { expect, test, vi } from 'vitest'
import { consoleError } from '#worker/test-support/console-spies.ts'
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

vi.mock('#worker/identity/background-mcp-user.ts', () => ({
	resolveBackgroundMcpUser: async (_db: D1Database, userId: string) => ({
		userId,
		email: 'owner@example.com',
		username: 'owner',
		displayName: 'Owner',
	}),
}))

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
		token: createToken({}),
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
		expect.objectContaining({}),
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
			...createToken({ packageId: 'pkg-gateway' }),
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
			...createToken({ packageId: 'pkg-gateway' }),
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

test('key-less packages.invoke takes the lean path: re-executes on repeat and writes no ledger row', async () => {
	const db = createDatabase()
	seedRuntimeDispatchPackages()
	repoMockModule.runBundledModuleWithRegistry.mockClear()
	let executionCount = 0
	repoMockModule.runBundledModuleWithRegistry.mockImplementation(async () => {
		executionCount += 1
		return { result: { handled: true, executionCount }, logs: [] }
	})
	const tools = createRuntimeDispatchTools(db)

	const request = {
		specifier: 'kody:@kentcdodds/discord-general-chat',
		options: {
			exportName: './handle-discord-message-created',
			params: { event: { id: 'message-1' } },
		},
	}
	const first = await tools.invoke(request)
	const second = await tools.invoke(request)

	// Ephemeral semantics: identical key-less calls execute independently.
	expect(first).toEqual({ handled: true, executionCount: 1 })
	expect(second).toEqual({ handled: true, executionCount: 2 })
	expect(repoMockModule.runBundledModuleWithRegistry).toHaveBeenCalledTimes(2)
	const runOptions =
		repoMockModule.runBundledModuleWithRegistry.mock.calls[0]?.[4]
	// No ledger row exists, so the run record carries neither an invocation id
	// nor an idempotency key (which downgrades it to on-failure persistence).
	expect(runOptions).toMatchObject({
		runRecord: {
			surface: 'export',
			invocationId: null,
			idempotencyKey: null,
		},
	})
})

test('keyed packages.invoke keeps exactly-once semantics: repeat calls replay the stored response', async () => {
	const db = createDatabase()
	seedRuntimeDispatchPackages()
	repoMockModule.runBundledModuleWithRegistry.mockClear()
	let executionCount = 0
	repoMockModule.runBundledModuleWithRegistry.mockImplementation(async () => {
		executionCount += 1
		return { result: { handled: true, executionCount }, logs: [] }
	})
	const tools = createRuntimeDispatchTools(db)

	const request = {
		specifier: 'kody:@kentcdodds/discord-general-chat',
		options: {
			exportName: './handle-discord-message-created',
			params: { event: { id: 'message-1' } },
			idempotencyKey: 'evt-keyed-1',
		},
	}
	const first = await tools.invoke(request)
	const second = await tools.invoke(request)

	expect(first).toEqual({ handled: true, executionCount: 1 })
	expect(second).toEqual({ handled: true, executionCount: 1 })
	expect(repoMockModule.runBundledModuleWithRegistry).toHaveBeenCalledTimes(1)
	const runOptions =
		repoMockModule.runBundledModuleWithRegistry.mock.calls[0]?.[4]
	// The keyed path owns its run record (claimed together with the ledger
	// row in one DO call), so the registry must not open a second one.
	expect(runOptions).toMatchObject({ runRecord: null })
	const ledgerRow = db.runLog.ledgerRows.find(
		(row) => row.idempotencyKey === 'evt-keyed-1',
	)
	expect(ledgerRow).toMatchObject({ status: 'completed' })
	const runRow = [...db.runLog.runRows.values()].find(
		(row) => row['idempotencyKey'] === 'evt-keyed-1',
	)
	expect(runRow).toMatchObject({
		surface: 'export',
		status: 'success',
		invocationId: ledgerRow?.id,
		idempotencyKey: 'evt-keyed-1',
	})
})

test('invokePackageExport enforces idempotency replay, mismatch, corruption, and persistence failures', async () => {
	const db = createDatabase()
	seedPackageResolution()
	repoMockModule.runBundledModuleWithRegistry.mockResolvedValue({
		result: { reply: 'hello discord' },
		logs: ['dispatched'],
	})

	const replayFirst = await invokePackageExport({
		env: createEnv(db),
		baseUrl: 'https://kody.dev',
		token: createToken(),
		request: {
			packageIdOrKodyId: 'discord-gateway',
			exportName: 'dispatch-message-created',
			params: { content: 'hi' },
			idempotencyKey: 'evt-replay',
			source: 'discord-gateway',
			topic: 'discord.message.created',
		},
	})
	const replaySecond = await invokePackageExport({
		env: createEnv(db),
		baseUrl: 'https://kody.dev',
		token: createToken(),
		request: {
			packageIdOrKodyId: 'discord-gateway',
			exportName: 'dispatch-message-created',
			params: { content: 'hi' },
			idempotencyKey: 'evt-replay',
			source: 'discord-gateway',
			topic: 'discord.message.created',
		},
	})

	expect(replayFirst.status).toBe(200)
	expect(replaySecond.status).toBe(200)
	expect(replaySecond.body).toMatchObject({
		ok: true,
		idempotency: {
			key: 'evt-replay',
			replayed: true,
		},
	})

	await invokePackageExport({
		env: createEnv(db),
		baseUrl: 'https://kody.dev',
		token: createToken(),
		request: {
			packageIdOrKodyId: 'discord-gateway',
			exportName: 'dispatch-message-created',
			params: { content: 'hi' },
			idempotencyKey: 'evt-mismatch',
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
			idempotencyKey: 'evt-mismatch',
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
			key: 'evt-mismatch',
			replayed: false,
		},
	})

	const ignoreCallsBefore =
		repoMockModule.runBundledModuleWithRegistry.mock.calls.length
	const ignoreFirst = await invokePackageExport({
		env: createEnv(db),
		baseUrl: 'https://kody.dev',
		token: createToken(),
		request: {
			packageIdOrKodyId: 'discord-gateway',
			exportName: 'dispatch-message-created',
			params: { content: 'hi', receivedAt: '2026-01-01T00:00:00.000Z' },
			idempotencyKey: 'evt-delivery-ignore',
			idempotencyParamsHash: 'ignore',
			source: 'discord-gateway',
			topic: 'discord.message.created',
		},
	})
	const ignoreReplay = await invokePackageExport({
		env: createEnv(db),
		baseUrl: 'https://kody.dev',
		token: createToken(),
		request: {
			packageIdOrKodyId: 'discord-gateway',
			exportName: 'dispatch-message-created',
			params: {
				content: 'different',
				receivedAt: '2026-01-01T00:00:01.000Z',
			},
			idempotencyKey: 'evt-delivery-ignore',
			idempotencyParamsHash: 'ignore',
			source: 'discord-gateway',
			topic: 'discord.message.created',
		},
	})
	expect(ignoreFirst.status).toBe(200)
	expect(ignoreReplay.status).toBe(200)
	expect(ignoreReplay.body).toEqual(ignoreFirst.body)
	expect(ignoreReplay.body).not.toMatchObject({
		idempotency: { replayed: true },
	})
	expect(repoMockModule.runBundledModuleWithRegistry.mock.calls.length).toBe(
		ignoreCallsBefore + 1,
	)

	const corruptFirst = await invokePackageExport({
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
	db.runLog.corruptStoredResponses()
	const corruptSecond = await invokePackageExport({
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

	expect(corruptFirst.status).toBe(200)
	expect(corruptSecond.status).toBe(409)
	expect(corruptSecond.body).toMatchObject({
		ok: false,
		error: {
			code: 'idempotency_response_unavailable',
		},
		idempotency: {
			key: 'evt-corrupt',
			replayed: false,
		},
	})
	expect(repoMockModule.runBundledModuleWithRegistry).toHaveBeenCalledTimes(4)

	const failingDb = createDatabase({ failClaim: true })
	seedPackageResolution()
	consoleError.mockImplementation(() => {})
	const persistenceFailure = await invokePackageExport({
		env: createEnv(failingDb),
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

	expect(persistenceFailure.status).toBe(500)
	expect(persistenceFailure.body).toMatchObject({
		ok: false,
		error: {
			code: 'idempotency_persistence_failed',
		},
		idempotency: {
			key: 'evt-insert-failure',
			replayed: false,
		},
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
	repoMockModule.runBundledModuleWithRegistry.mockReset()
	repoMockModule.runBundledModuleWithRegistry.mockResolvedValue({
		result: { handled: true },
		logs: ['completed'],
	})
	const request = {
		packageIdOrKodyId: 'discord-gateway',
		exportName: 'dispatch-message-created',
		params: { content: 'hi' },
		idempotencyKey: 'evt-finish-failure',
		source: 'webhook',
		topic: 'webhook:discord-gateway:message',
	}

	const first = await invokePackageExport({
		env: createEnv(db),
		baseUrl: 'https://kody.dev',
		token: createToken(),
		request,
	})
	const retry = await invokePackageExport({
		env: createEnv(db),
		baseUrl: 'https://kody.dev',
		token: createToken(),
		request,
	})

	expect(first).toMatchObject({
		status: 500,
		body: {
			ok: false,
			error: { code: 'idempotency_persistence_failed' },
		},
	})
	expect(retry).toMatchObject({
		status: 409,
		body: {
			ok: false,
			error: { code: 'invocation_in_progress' },
		},
	})
	expect(repoMockModule.runBundledModuleWithRegistry).toHaveBeenCalledTimes(1)
	expect(db.runLog.ledgerRows[0]?.status).toBe('in_progress')
	expect(consoleError).toHaveBeenCalledWith(
		'package invocation completed-result persistence failed',
		'RunLog finish unavailable',
	)
})

test('oversized terminal responses are not stored so backups stay restorable', async () => {
	const db = createDatabase()
	seedPackageResolution()
	repoMockModule.runBundledModuleWithRegistry.mockResolvedValue({
		// Serialized response_json above maxStoredInvocationResponseJsonBytes.
		result: { blob: 'x'.repeat(maxStoredInvocationResponseJsonBytes + 1) },
		logs: [],
	})

	const first = await invokePackageExport({
		env: createEnv(db),
		baseUrl: 'https://kody.dev',
		token: createToken(),
		request: {
			packageIdOrKodyId: 'discord-gateway',
			exportName: 'dispatch-message-created',
			params: { content: 'hi' },
			idempotencyKey: 'evt-oversized',
			source: 'discord-gateway',
			topic: 'discord.message.created',
		},
	})
	const duplicate = await invokePackageExport({
		env: createEnv(db),
		baseUrl: 'https://kody.dev',
		token: createToken(),
		request: {
			packageIdOrKodyId: 'discord-gateway',
			exportName: 'dispatch-message-created',
			params: { content: 'hi' },
			idempotencyKey: 'evt-oversized',
			source: 'discord-gateway',
			topic: 'discord.message.created',
		},
	})

	// The first call still returns the live response in full.
	expect(first.status).toBe(200)
	expect(first.body).toMatchObject({ ok: true })
	// The duplicate is deduplicated (no re-execution) but cannot replay the
	// dropped oversized response.
	expect(duplicate.status).toBe(409)
	expect(duplicate.body).toMatchObject({
		ok: false,
		error: { code: 'idempotency_response_unavailable' },
		idempotency: { key: 'evt-oversized', replayed: false },
	})
	expect(repoMockModule.runBundledModuleWithRegistry).toHaveBeenCalledTimes(1)
})

test('a pre-migration-style key misses cleanly: it executes fresh instead of erroring', async () => {
	// Keys claimed before the ledger moved into the RunLog DO no longer have
	// any store to replay from (the D1 table is dropped). A redelivery for
	// such a key is indistinguishable from a brand-new key: it claims in the
	// DO and executes, without touching D1 at all (the fake D1 above throws
	// on any package_invocations statement).
	const db = createDatabase()
	seedPackageResolution()
	repoMockModule.runBundledModuleWithRegistry.mockClear()
	repoMockModule.runBundledModuleWithRegistry.mockResolvedValue({
		result: { reply: 'executed fresh' },
		logs: [],
	})

	const response = await invokePackageExport({
		env: createEnv(db),
		baseUrl: 'https://kody.dev',
		token: createToken(),
		request: {
			packageIdOrKodyId: 'discord-gateway',
			exportName: 'dispatch-message-created',
			params: { content: 'hi' },
			idempotencyKey: 'evt-from-before-the-migration',
			source: 'discord-gateway',
			topic: 'discord.message.created',
		},
	})

	expect(response.status).toBe(200)
	expect(response.body).toMatchObject({
		ok: true,
		result: { reply: 'executed fresh' },
		idempotency: { key: 'evt-from-before-the-migration', replayed: false },
	})
	expect(repoMockModule.runBundledModuleWithRegistry).toHaveBeenCalledTimes(1)
	expect(
		db.runLog.ledgerRows.find(
			(row) => row.idempotencyKey === 'evt-from-before-the-migration',
		),
	).toMatchObject({ status: 'completed' })
})

test('invokePackageExport records request source without gating auth', async () => {
	const db = createDatabase()
	seedPackageResolution()
	repoMockModule.runBundledModuleWithRegistry.mockResolvedValue({
		result: { reply: 'hello trusted client' },
		logs: ['invoked'],
	})

	const namedSource = await invokePackageExport({
		env: createEnv(db),
		baseUrl: 'https://kody.dev',
		token: createToken({
			exportNames: ['*'],
		}),
		request: {
			packageIdOrKodyId: 'discord-gateway',
			exportName: 'dispatch-message-created',
			params: { content: 'hi' },
			idempotencyKey: 'evt-personal-client',
			source: 'personal-client',
		},
	})

	expect(namedSource.status).toBe(200)
	expect(namedSource.body).toMatchObject({
		ok: true,
		exportName: './dispatch-message-created',
		source: 'personal-client',
		result: { reply: 'hello trusted client' },
	})

	const otherNamedSource = await invokePackageExport({
		env: createEnv(db),
		baseUrl: 'https://kody.dev',
		token: createToken({
			exportNames: ['*'],
		}),
		request: {
			packageIdOrKodyId: 'discord-gateway',
			exportName: 'dispatch-message-created',
			params: { content: 'hi' },
			idempotencyKey: 'evt-shortcuts',
			source: 'shortcuts',
		},
	})

	expect(otherNamedSource.status).toBe(200)
	expect(otherNamedSource.body).toMatchObject({
		ok: true,
		source: 'shortcuts',
	})

	const unlabeled = await invokePackageExport({
		env: createEnv(db),
		baseUrl: 'https://kody.dev',
		token: createToken({
			exportNames: ['*'],
		}),
		request: {
			packageIdOrKodyId: 'discord-gateway',
			exportName: 'dispatch-message-created',
			params: { content: 'hi' },
			idempotencyKey: 'evt-unlabeled',
		},
	})

	expect(unlabeled.status).toBe(200)
	expect(unlabeled.body).toMatchObject({
		ok: true,
		result: { reply: 'hello trusted client' },
	})
	expect(repoMockModule.runBundledModuleWithRegistry).toHaveBeenCalledTimes(3)

	const scopedDeniedByExport = await invokePackageExport({
		env: createEnv(db),
		baseUrl: 'https://kody.dev',
		token: createToken({
			exportNames: ['./other-export'],
		}),
		request: {
			packageIdOrKodyId: 'discord-gateway',
			exportName: 'dispatch-message-created',
			params: { content: 'hi' },
			idempotencyKey: 'evt-scoped-denied-export',
			source: 'discord-gateway',
		},
	})

	expect(scopedDeniedByExport.status).toBe(403)
	expect(scopedDeniedByExport.body).toMatchObject({
		ok: false,
		error: {
			code: 'export_not_allowed',
		},
	})

	const deniedByPackage = await invokePackageExport({
		env: createEnv(db),
		baseUrl: 'https://kody.dev',
		token: createToken({
			packageId: 'pkg-other',
			exportNames: ['*'],
		}),
		request: {
			packageIdOrKodyId: 'discord-gateway',
			exportName: 'dispatch-message-created',
			params: { content: 'hi' },
			idempotencyKey: 'evt-wrong-package',
			source: 'discord-gateway',
		},
	})

	expect(deniedByPackage.status).toBe(403)
	expect(deniedByPackage.body).toMatchObject({
		ok: false,
		error: {
			code: 'package_not_allowed',
		},
	})
})

test('invokePackageExport stores terminal failures for execution errors and missing exports', async () => {
	const db = createDatabase()
	seedPackageResolution()
	repoMockModule.runBundledModuleWithRegistry.mockResolvedValue({
		error: new Error('Discord downstream failed'),
		logs: ['before-error'],
	})

	const executionFailure = await invokePackageExport({
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

	expect(executionFailure.status).toBe(500)
	expect(executionFailure.body).toMatchObject({
		ok: false,
		error: {
			code: 'execution_failed',
			message: 'Discord downstream failed',
		},
		logs: ['before-error'],
	})

	repoMockModule.runBundledModuleWithRegistry.mockResolvedValue({
		error: new Error('Durable Object reset because its code was updated.'),
		logs: [],
	})
	const durableObjectReset = await invokePackageExport({
		env: createEnv(db),
		baseUrl: 'https://kody.dev',
		token: createToken(),
		request: {
			packageIdOrKodyId: 'discord-gateway',
			exportName: 'dispatch-message-created',
			params: { content: 'hi' },
			idempotencyKey: 'evt-do-reset',
			source: 'discord-gateway',
		},
	})
	expect(durableObjectReset.status).toBe(503)
	expect(durableObjectReset.body).toMatchObject({
		ok: false,
		error: {
			code: 'durable_object_reset',
			message: 'Durable Object reset because its code was updated.',
		},
	})

	repoMockModule.runBundledModuleWithRegistry.mockResolvedValue({
		error:
			'Connection closed: this Durable Object instance is no longer active. Reconnect or retry the request.',
		logs: [],
	})
	const durableObjectInactiveClose = await invokePackageExport({
		env: createEnv(db),
		baseUrl: 'https://kody.dev',
		token: createToken(),
		request: {
			packageIdOrKodyId: 'discord-gateway',
			exportName: 'dispatch-message-created',
			params: { content: 'hi' },
			idempotencyKey: 'evt-do-inactive-close',
			source: 'discord-gateway',
		},
	})
	expect(durableObjectInactiveClose.status).toBe(503)
	expect(durableObjectInactiveClose.body).toMatchObject({
		ok: false,
		error: {
			code: 'durable_object_reset',
			message:
				'Connection closed: this Durable Object instance is no longer active. Reconnect or retry the request.',
		},
	})

	repoMockModule.runBundledModuleWithRegistry.mockClear()
	const missingExportFirst = await invokePackageExport({
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
	const missingExportSecond = await invokePackageExport({
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

	expect(missingExportFirst.status).toBe(404)
	expect(missingExportFirst.body).toMatchObject({
		ok: false,
		error: {
			code: 'export_not_found',
		},
		idempotency: {
			key: 'evt-missing-export',
			replayed: false,
		},
	})
	expect(missingExportSecond.status).toBe(404)
	expect(missingExportSecond.body).toMatchObject({
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
			publishedCommit: 'commit-1',
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
		hidden: false,
		isPrivate: false,
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
				email: 'owner@example.com',
				displayName: 'Owner',
			}),
			storageContext: {
				sessionId: null,
				appId: 'pkg-1',
				packageId: 'pkg-1',
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
	// Package invocation runs no longer bind ambient `storage`: the package
	// bucket is reached via packageStorage(), granted through packageContext.
	expect(
		(runOptions as { storageTools?: unknown }).storageTools,
	).toBeUndefined()

	db.runLog.seedStaleInvocation(
		'email:message-stale:pkg-1:email.message.received',
	)
	const recovered = await invokePackageSubscription({
		env: createEnv(db),
		baseUrl: 'https://kody.dev',
		savedPackage,
		topic: 'email.message.received',
		params: {
			event: 'email.message.received',
			message: { id: 'message-123' },
		},
		idempotencyKey: 'email:message-stale:pkg-1:email.message.received',
		source: 'email',
	})
	expect(recovered.status).toBe(200)
	expect(repoMockModule.runBundledModuleWithRegistry).toHaveBeenCalledTimes(2)

	const freshKey = 'email:message-fresh:pkg-1:email.message.received'
	db.runLog.seedFreshInvocation(freshKey)
	const completionTimer = setTimeout(() => {
		db.runLog.completeInvocation(freshKey)
	}, 150)
	try {
		const polled = await invokePackageSubscription({
			env: createEnv(db),
			baseUrl: 'https://kody.dev',
			savedPackage,
			topic: 'email.message.received',
			params: {
				event: 'email.message.received',
				message: { id: 'message-123' },
			},
			idempotencyKey: freshKey,
			source: 'email',
		})
		expect(polled.status).toBe(200)
		expect(repoMockModule.runBundledModuleWithRegistry).toHaveBeenCalledTimes(2)
	} finally {
		clearTimeout(completionTimer)
	}

	const transientKey = 'email:message-transient:pkg-1:email.message.received'
	// The commit-keyed artifact cache is warm from the invocations above and
	// would absorb the injected KV failure; this scenario is about a cold
	// artifact load failing transiently.
	clearInvokeContractCachesForTests()
	repoMockModule.loadPublishedBundleArtifactByIdentity.mockRejectedValueOnce(
		new Error('KV timeout'),
	)
	const transientFailure = await invokePackageSubscription({
		env: createEnv(db),
		baseUrl: 'https://kody.dev',
		savedPackage,
		topic: 'email.message.received',
		params: {
			event: 'email.message.received',
			message: { id: 'message-123' },
		},
		idempotencyKey: transientKey,
		source: 'email',
	})
	expect(transientFailure).toMatchObject({
		status: 503,
		body: { error: { code: 'artifact_preparation_failed' } },
	})
	const recoveredTransient = await invokePackageSubscription({
		env: createEnv(db),
		baseUrl: 'https://kody.dev',
		savedPackage,
		topic: 'email.message.received',
		params: {
			event: 'email.message.received',
			message: { id: 'message-123' },
		},
		idempotencyKey: transientKey,
		source: 'email',
	})
	expect(recoveredTransient.status).toBe(200)
})
