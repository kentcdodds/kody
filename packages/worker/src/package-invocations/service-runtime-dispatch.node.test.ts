import { expect, test, vi } from 'vitest'
import type * as packageSourceModule from '#worker/package-registry/source.ts'
import { createMcpCallerContext } from '#mcp/context.ts'
import { consoleError } from '#worker/test-support/console-spies.ts'
import {
	createExecutePackageInvokeTools,
	createPackageRuntimeInvokeTools,
	deliverPackageEvent,
} from './service.ts'
import {
	packageInvocationsRepoMockModule as repoMockModule,
	createDatabase,
	createEnv,
	seedRuntimeDispatchPackages,
	createRuntimeDispatchTools,
	createRuntimeEventTools,
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
	loadPackageSourceRowForUser: (
		...args: Parameters<typeof packageSourceModule.loadPackageSourceRowForUser>
	) => repoMockModule.loadPackageSourceRowForUser(...args),
	loadPackageManifestForSource: (
		...args: Parameters<typeof packageSourceModule.loadPackageManifestForSource>
	) => repoMockModule.loadPackageManifestForSource(...args),
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

const meCallerContext = createMcpCallerContext({
	baseUrl: 'https://kody.dev',
	user: { userId: 'user-123', email: 'me@example.com', displayName: 'Me' },
})
const gatewayContext = {
	packageId: 'pkg-gateway',
	kodyId: 'discord-gateway',
	sourceId: 'source-gateway',
}
const messageCreated = '@kentcdodds/discord.message.created'
const generalChat = 'kody:@kentcdodds/discord-general-chat'
const handlerExport = './handle-discord-message-created'
const missingPackageError =
	'packages.invoke contract check failed: Kody package specifier "kody:@kentcdodds/missing-package" could not be resolved for this caller.'
const missingExportError =
	'packages.invoke contract check failed: Package "discord-general-chat" does not define export "./missing-export".'

function runtimeTools(
	db: ReturnType<typeof createDatabase>,
	input: Partial<Parameters<typeof createPackageRuntimeInvokeTools>[0]> = {},
) {
	return createPackageRuntimeInvokeTools({
		env: createEnv(db),
		baseUrl: 'https://kody.dev',
		callerContext: meCallerContext,
		packageContext: gatewayContext,
		packageInvokeDepth: 0,
		...input,
	})
}

function deliver(
	db: ReturnType<typeof createDatabase>,
	message: Parameters<typeof deliverPackageEvent>[0]['message'],
) {
	return deliverPackageEvent({
		env: createEnv(db),
		baseUrl: 'https://kody.dev',
		message,
	})
}

function failSubscriberManifestLoads(
	seed: ReturnType<typeof seedRuntimeDispatchPackages>,
) {
	repoMockModule.loadPackageManifestBySourceId.mockImplementation(
		async (input: { sourceId: string }) => {
			if (input.sourceId === 'source-subscriber') {
				throw new Error('manifest unavailable')
			}
			return {
				source: seed.sources.get(input.sourceId),
				manifest: seed.manifests.get(input.sourceId),
			}
		},
	)
}

/** Rewrites a seeded manifest `kody` block and its package.json source file. */
function patchSeededManifest(
	seed: ReturnType<typeof seedRuntimeDispatchPackages>,
	sourceId: string,
	kody: Record<string, unknown>,
) {
	const manifest = seed.manifests.get(sourceId) as {
		kody: Record<string, unknown>
	}
	Object.assign(manifest.kody, kody)
	const files = seed.sourceFiles.get(sourceId)
	if (files) files['package.json'] = JSON.stringify(manifest)
}

test('runtime invoke tools reject the removed object API before resolving a target', async () => {
	const callerContext = createMcpCallerContext({
		baseUrl: 'https://kody.dev',
		user: {
			userId: 'private-user-id',
			email: 'private@example.com',
			displayName: 'Private User',
		},
	})
	await expect(
		createExecutePackageInvokeTools({
			env: createEnv(createDatabase()),
			baseUrl: 'https://kody.dev',
			callerContext,
		}).invoke({
			kodyId: 'private-kody-id',
			exportName: './private-export',
		} as never),
	).rejects.toThrow(/Object-only packages\.invoke was removed/)
	expect(repoMockModule.getSavedPackageById).not.toHaveBeenCalled()
	expect(repoMockModule.getSavedPackageByKodyId).not.toHaveBeenCalled()
	expect(repoMockModule.getSavedPackageByName).not.toHaveBeenCalled()
})

test('package runtime dispatch enqueues declared events and validates payloadSchema', async () => {
	const db = createDatabase()
	const seed = seedRuntimeDispatchPackages()
	const send = vi.fn<(message: unknown) => Promise<undefined>>(
		async () => undefined,
	)
	const eventTools = (packageInvokeDepth?: number) =>
		createRuntimeEventTools(db, {
			envOverrides: { PACKAGE_EVENTS_DISPATCH_QUEUE: { send } },
			packageInvokeDepth,
		})
	const tools = eventTools()

	const result = await tools.dispatch({
		topic: messageCreated,
		idempotencyKey: 'discord:message-create:123',
		payload: { messageId: '123', channelId: '456' },
	})

	expect(send).toHaveBeenCalledTimes(1)
	expect(send).toHaveBeenCalledWith({
		userId: 'user-123',
		topic: messageCreated,
		idempotencyKey: 'discord:message-create:123',
		payload: { messageId: '123', channelId: '456' },
		source: { packageId: 'pkg-gateway', kodyId: 'discord-gateway' },
		invokeDepth: 1,
	})
	// Queued delivery never invokes subscribers inside the emitting request.
	expect(repoMockModule.runBundledModuleWithRegistry).not.toHaveBeenCalled()
	expect(result).toEqual({
		topic: messageCreated,
		source: {
			type: 'package',
			packageId: 'pkg-gateway',
			kodyId: 'discord-gateway',
		},
		idempotencyKey: 'discord:message-create:123',
		status: 'enqueued',
	})

	for (const [dispatchTools, input, error] of [
		[
			tools,
			{
				topic: '@kentcdodds/discord.reaction.created',
				idempotencyKey: 'discord:reaction-create:123',
				payload: { reactionId: '123' },
			},
			/does not declare emitted event "@kentcdodds\/discord.reaction.created"/,
		],
		[
			tools,
			{
				topic: messageCreated,
				idempotencyKey: 'discord:message-create:huge',
				payload: { blob: 'x'.repeat(65 * 1024) },
			},
			/payload is \d+ bytes; the maximum is 65536 bytes/,
		],
		[
			tools,
			{
				topic: messageCreated,
				idempotencyKey: 'discord:message-create:invalid-shape',
				payload: ['not', 'an', 'object'] as never,
			},
			'events.dispatch payload must be a JSON object when provided.',
		],
		[
			eventTools(8),
			{
				topic: messageCreated,
				idempotencyKey: 'discord:message-create:deep',
				payload: {},
			},
			/exceeded the maximum nested invocation depth/,
		],
	] as const) {
		await expect(dispatchTools.dispatch(input)).rejects.toThrow(error)
	}
	expect(send).toHaveBeenCalledTimes(1)

	patchSeededManifest(seed, 'source-gateway', {
		emits: {
			[messageCreated]: {
				description: 'A Discord message was created.',
				payloadSchema: {
					type: 'object',
					properties: {
						messageId: { type: 'string', minLength: 1 },
						channelId: { type: 'string' },
					},
					required: ['messageId'],
					additionalProperties: false,
				},
			},
		},
	})
	send.mockClear()
	const schemaTools = eventTools()
	await expect(
		schemaTools.dispatch({
			topic: messageCreated,
			idempotencyKey: 'discord:message-create:bad',
			payload: { channelId: '456', extra: true },
		}),
	).rejects.toThrow(
		/payload does not match the declared payloadSchema[\s\S]*missing required property "messageId"[\s\S]*unexpected property "extra"/,
	)
	expect(send).not.toHaveBeenCalled()
	await expect(
		schemaTools.dispatch({
			topic: messageCreated,
			idempotencyKey: 'discord:message-create:ok',
			payload: { messageId: '123', channelId: '456' },
		}),
	).resolves.toMatchObject({ status: 'enqueued' })
	expect(send).toHaveBeenCalledTimes(1)
})

test('package events deliver with filters, idempotent replay, and retryable failures', async () => {
	const db = createDatabase()
	const seed = seedRuntimeDispatchPackages()
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
	const baseMessage = {
		userId: 'user-123',
		topic: messageCreated,
		source: { packageId: 'pkg-gateway', kodyId: 'discord-gateway' },
		invokeDepth: 1,
	}
	const message = {
		...baseMessage,
		idempotencyKey: 'discord:message-create:123',
		payload: { messageId: '123', channelId: '456' },
	}

	const first = await deliver(db, message)
	const second = await deliver(db, message)

	expect(repoMockModule.runBundledModuleWithRegistry).toHaveBeenCalledTimes(1)
	expect(
		repoMockModule.runBundledModuleWithRegistry.mock.calls[0]?.[3],
	).toEqual({
		event: messageCreated,
		source: {
			type: 'package',
			package_id: 'pkg-gateway',
			kody_id: 'discord-gateway',
		},
		idempotency_key: 'discord:message-create:123',
		payload: { messageId: '123', channelId: '456' },
	})
	const subscriber = {
		packageId: 'pkg-subscriber',
		kodyId: 'discord-general-chat',
	}
	expect(first).toMatchObject({
		topic: messageCreated,
		source: {
			type: 'package',
			packageId: 'pkg-gateway',
			kodyId: 'discord-gateway',
		},
		delivered: 1,
		failed: 0,
		subscribers: [
			{
				...subscriber,
				handler: 'src/handle-discord-message-created.ts',
				status: 'completed',
			},
		],
	})
	expect(second).toMatchObject({
		delivered: 1,
		failed: 0,
		subscribers: [{ ...subscriber, status: 'replayed' }],
	})

	failSubscriberManifestLoads(seed)
	await expect(
		deliver(db, { ...message, idempotencyKey: 'discord:manifest-error' }),
	).rejects.toThrow(
		/Failed to load package manifest for package event dispatch/,
	)

	patchSeededManifest(seedRuntimeDispatchPackages(), 'source-subscriber', {
		subscriptions: {
			[messageCreated]: {
				handler: './src/handle-discord-message-created.ts',
				filters: { channelId: '456' },
			},
		},
	})
	repoMockModule.runBundledModuleWithRegistry.mockClear()
	repoMockModule.runBundledModuleWithRegistry.mockResolvedValue({
		result: { handled: true },
		logs: [],
	})
	const filteredOut = await deliver(db, {
		...baseMessage,
		idempotencyKey: 'discord:other-channel',
		payload: { messageId: '1', channelId: '999' },
	})
	expect(filteredOut).toMatchObject({ delivered: 0, failed: 0 })
	expect(filteredOut.subscribers).toEqual([])
	expect(repoMockModule.runBundledModuleWithRegistry).not.toHaveBeenCalled()
	const matching = await deliver(db, {
		...baseMessage,
		idempotencyKey: 'discord:matching-channel',
		payload: { messageId: '2', channelId: '456' },
	})
	expect(matching).toMatchObject({ delivered: 1, failed: 0 })
	expect(repoMockModule.runBundledModuleWithRegistry).toHaveBeenCalledTimes(1)

	seedRuntimeDispatchPackages()
	repoMockModule.runBundledModuleWithRegistry.mockClear()
	consoleError.mockImplementation(() => {})
	await expect(
		deliver(createDatabase({ failClaim: true }), {
			...baseMessage,
			idempotencyKey: 'discord:message-create:claim-failure',
			payload: { messageId: '1' },
		}),
	).rejects.toThrow('Package event dispatch was incomplete.')
	expect(repoMockModule.runBundledModuleWithRegistry).not.toHaveBeenCalled()
})

test('package events fall back to inline delivery without a queue binding', async () => {
	const db = createDatabase()
	seedRuntimeDispatchPackages()
	repoMockModule.runBundledModuleWithRegistry.mockResolvedValue({
		result: { handled: true },
		logs: [],
	})
	const tools = createRuntimeEventTools(db)

	const result = await tools.dispatch({
		topic: messageCreated,
		idempotencyKey: 'discord:message-create:inline',
		payload: { messageId: 'inline-1' },
	})

	expect(result).toMatchObject({ status: 'delivered_inline' })
	expect(repoMockModule.runBundledModuleWithRegistry).toHaveBeenCalledTimes(1)
	expect(
		repoMockModule.runBundledModuleWithRegistry.mock.calls[0]?.[3],
	).toMatchObject({
		event: messageCreated,
		payload: { messageId: 'inline-1' },
	})

	// Inline delivery failures are logged, never surfaced to the emitter.
	failSubscriberManifestLoads(seedRuntimeDispatchPackages())
	consoleError.mockImplementation(() => {})
	await expect(
		tools.dispatch({
			topic: messageCreated,
			idempotencyKey: 'discord:message-create:inline-error',
			payload: { messageId: 'inline-2' },
		}),
	).resolves.toMatchObject({ status: 'delivered_inline' })
	expect(consoleError).toHaveBeenCalledWith(
		'package-events-inline-delivery-failed',
		expect.objectContaining({ topic: messageCreated }),
	)
})

test('package runtime invoke contract-checks once and executes the target', async () => {
	const db = createDatabase()
	seedRuntimeDispatchPackages()
	repoMockModule.runBundledModuleWithRegistry.mockResolvedValue({
		result: { handled: true, eventId: 'message-1' },
		logs: [],
	})

	const result = await createRuntimeDispatchTools(db).invoke({
		specifier: generalChat,
		options: {
			exportName: 'handle-discord-message-created',
			params: { event: { id: 'message-1' }, dryRun: true },
			idempotencyKey: 'message-1',
			topic: 'discord.message.created',
		},
	})

	expect(result).toEqual({ handled: true, eventId: 'message-1' })
	// One logical call resolves its package exactly once: the mandatory
	// contract check preloads the manifest and the invoke phase reuses it.
	expect(repoMockModule.loadPackageManifestForSource).toHaveBeenCalledTimes(1)
	expect(repoMockModule.runBundledModuleWithRegistry).toHaveBeenCalledTimes(1)
})

test('execute runtime invoke canonicalizes a prefixless target and preserves execute provenance', async () => {
	const db = createDatabase()
	seedRuntimeDispatchPackages()
	repoMockModule.runBundledModuleWithRegistry.mockResolvedValue({
		result: { handled: true, eventId: 'message-1' },
		logs: [],
	})
	repoMockModule.recordAgentPackageConversationUse.mockResolvedValue(undefined)
	const tools = createExecutePackageInvokeTools({
		env: createEnv(db),
		baseUrl: 'https://kody.dev',
		callerContext: meCallerContext,
		conversationId: 'conv-execute-1',
	})

	const result = await tools.invoke({
		specifier:
			'@kentcdodds/discord-general-chat/handle-discord-message-created',
		options: { params: { event: { id: 'message-1' } } },
	})

	expect(result).toEqual({ handled: true, eventId: 'message-1' })
	expect(repoMockModule.runBundledModuleWithRegistry).toHaveBeenCalledTimes(1)
	const runCall = repoMockModule.runBundledModuleWithRegistry.mock.calls[0]
	expect(runCall?.[1]).toMatchObject({
		user: {
			userId: 'user-123',
			email: 'owner@example.com',
			displayName: 'Owner',
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
		runRecord: {
			packageId: 'pkg-subscriber',
			kodyId: 'discord-general-chat',
			surface: 'export',
			metadata: {
				exportName: handlerExport,
				source: 'execute',
				topic: null,
			},
		},
	})
	expect(
		(runCall?.[4] as { packageInvokeTools?: unknown } | undefined)
			?.packageInvokeTools,
	).toBeDefined()
	expect(repoMockModule.recordAgentPackageConversationUse).toHaveBeenCalledWith(
		expect.anything(),
		{
			userId: 'user-123',
			packageId: 'pkg-subscriber',
			conversationId: 'conv-execute-1',
		},
	)
})

test('package runtime dispatch rejects invalid targets before and during invocation', async () => {
	const db = createDatabase()
	seedRuntimeDispatchPackages()
	const tools = createRuntimeDispatchTools(db)

	for (const [input, error] of [
		[
			{
				specifier: 'kody:@kentcdodds/missing-package',
				options: { exportName: handlerExport, params: {} },
			},
			missingPackageError,
		],
		[
			{
				specifier: generalChat,
				options: { exportName: './missing-export', params: {} },
			},
			missingExportError,
		],
		[
			{
				specifier: generalChat,
				options: { exportName: handlerExport, params: 'not-an-object' },
			},
			'packages.invoke params must be a JSON object when provided.',
		],
	] as const) {
		await expect(tools.invoke(input as never)).rejects.toThrow(error)
	}
	expect(repoMockModule.runBundledModuleWithRegistry).not.toHaveBeenCalled()

	const nestedTools = () =>
		runtimeTools(db, {
			parentRunRecord: {
				...gatewayContext,
				surface: 'export',
				name: './dispatch-message-created',
				idempotencyKey: 'message-1',
			},
		})
	repoMockModule.getSavedPackageByName.mockResolvedValueOnce(null)
	await expect(
		nestedTools().invoke({
			specifier: 'kody:@kentcdodds/missing-package',
			options: { exportName: handlerExport },
		}),
	).rejects.toThrow(missingPackageError)

	seedRuntimeDispatchPackages()
	await expect(
		nestedTools().invoke({
			specifier: generalChat,
			options: {
				exportName: './missing-export',
				params: { event: { id: 'message-1' } },
			},
		}),
	).rejects.toThrow(missingExportError)
})

// Auto-generated idempotency keys were removed with the lean key-less path:
// nested key-less invokes are ephemeral and always re-execute, regardless of
// the parent run's identity. Exactly-once now requires an explicit key.
test('key-less nested invokes re-execute for every parent run', async () => {
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
				result: { marker: params?.marker, value: params?.value },
				logs: [],
			}
		},
	)

	for (const name of ['./first-parent', './second-parent']) {
		const result = await runtimeTools(db, {
			parentRunRecord: {
				...gatewayContext,
				surface: 'export',
				name,
				idempotencyKey: 'shared-domain-event',
			},
		}).invoke({
			specifier: generalChat,
			options: {
				exportName: handlerExport,
				params: { marker: 'same-child-call', value: 1 },
			},
		})
		expect(result).toEqual({ marker: 'same-child-call', value: 1 })
	}
	expect(repoMockModule.runBundledModuleWithRegistry).toHaveBeenCalledTimes(2)
})

test('package runtime invocation requires package context and enforces loop depth', async () => {
	const db = createDatabase()
	seedRuntimeDispatchPackages()
	const invoke = {
		specifier: generalChat,
		options: { exportName: handlerExport },
	} as const

	await expect(
		runtimeTools(db, { packageContext: null }).invoke(invoke),
	).rejects.toThrow('packages.invoke requires a package runtime context.')
	await expect(
		runtimeTools(db, { packageInvokeDepth: 8 }).invoke(invoke),
	).rejects.toThrow(
		'packages.invoke exceeded the maximum nested invocation depth (8).',
	)
})
