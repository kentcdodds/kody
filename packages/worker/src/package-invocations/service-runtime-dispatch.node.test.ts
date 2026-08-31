import { expect, test, vi } from 'vitest'
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

test('runtime invoke tools expose only the supported invoke helper', () => {
	const db = createDatabase()
	seedRuntimeDispatchPackages()
	const tools = createRuntimeDispatchTools(db) as Record<string, unknown>

	expect(typeof tools.invoke).toBe('function')
})

test('runtime invoke tools reject the removed object API before resolving a target', async () => {
	const db = createDatabase()
	const env = createEnv(db)
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
			env,
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
	const { manifests, sourceFiles } = seedRuntimeDispatchPackages()
	repoMockModule.runBundledModuleWithRegistry.mockClear()
	const send = vi.fn<(message: unknown) => Promise<undefined>>(
		async () => undefined,
	)
	const tools = createRuntimeEventTools(db, {
		envOverrides: { PACKAGE_EVENTS_DISPATCH_QUEUE: { send } },
	})

	const result = await tools.dispatch({
		topic: '@kentcdodds/discord.message.created',
		idempotencyKey: 'discord:message-create:123',
		payload: {
			messageId: '123',
			channelId: '456',
		},
	})

	expect(send).toHaveBeenCalledTimes(1)
	expect(send).toHaveBeenCalledWith({
		userId: 'user-123',
		topic: '@kentcdodds/discord.message.created',
		idempotencyKey: 'discord:message-create:123',
		payload: {
			messageId: '123',
			channelId: '456',
		},
		source: {
			packageId: 'pkg-gateway',
			kodyId: 'discord-gateway',
		},
		invokeDepth: 1,
	})
	// Queued delivery never invokes subscribers inside the emitting request.
	expect(repoMockModule.runBundledModuleWithRegistry).not.toHaveBeenCalled()
	expect(result).toEqual({
		topic: '@kentcdodds/discord.message.created',
		source: {
			type: 'package',
			packageId: 'pkg-gateway',
			kodyId: 'discord-gateway',
		},
		idempotencyKey: 'discord:message-create:123',
		status: 'enqueued',
	})

	await expect(
		tools.dispatch({
			topic: '@kentcdodds/discord.reaction.created',
			idempotencyKey: 'discord:reaction-create:123',
			payload: {
				reactionId: '123',
			},
		}),
	).rejects.toThrow(
		/does not declare emitted event "@kentcdodds\/discord.reaction.created"/,
	)
	expect(send).toHaveBeenCalledTimes(1)

	await expect(
		tools.dispatch({
			topic: '@kentcdodds/discord.message.created',
			idempotencyKey: 'discord:message-create:huge',
			payload: { blob: 'x'.repeat(65 * 1024) },
		}),
	).rejects.toThrow(/payload is \d+ bytes; the maximum is 65536 bytes/)
	expect(send).toHaveBeenCalledTimes(1)
	await expect(
		tools.dispatch({
			topic: '@kentcdodds/discord.message.created',
			idempotencyKey: 'discord:message-create:invalid-shape',
			payload: ['not', 'an', 'object'] as never,
		}),
	).rejects.toThrow(
		'events.dispatch payload must be a JSON object when provided.',
	)
	expect(send).toHaveBeenCalledTimes(1)

	const depthCappedTools = createRuntimeEventTools(db, {
		envOverrides: { PACKAGE_EVENTS_DISPATCH_QUEUE: { send } },
		packageInvokeDepth: 8,
	})
	await expect(
		depthCappedTools.dispatch({
			topic: '@kentcdodds/discord.message.created',
			idempotencyKey: 'discord:message-create:deep',
			payload: {},
		}),
	).rejects.toThrow(/exceeded the maximum nested invocation depth/)
	expect(send).toHaveBeenCalledTimes(1)

	const gatewayManifest = manifests.get('source-gateway') as {
		kody: {
			emits?: Record<
				string,
				{ description: string; payloadSchema?: Record<string, unknown> }
			>
		}
	}
	gatewayManifest.kody.emits = {
		'@kentcdodds/discord.message.created': {
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
	}
	const gatewayFiles = sourceFiles.get('source-gateway')
	if (gatewayFiles) {
		gatewayFiles['package.json'] = JSON.stringify(gatewayManifest)
	}
	send.mockClear()
	const schemaTools = createRuntimeEventTools(db, {
		envOverrides: { PACKAGE_EVENTS_DISPATCH_QUEUE: { send } },
	})
	await expect(
		schemaTools.dispatch({
			topic: '@kentcdodds/discord.message.created',
			idempotencyKey: 'discord:message-create:bad',
			payload: { channelId: '456', extra: true },
		}),
	).rejects.toThrow(
		/payload does not match the declared payloadSchema[\s\S]*missing required property "messageId"[\s\S]*unexpected property "extra"/,
	)
	expect(send).not.toHaveBeenCalled()
	await expect(
		schemaTools.dispatch({
			topic: '@kentcdodds/discord.message.created',
			idempotencyKey: 'discord:message-create:ok',
			payload: { messageId: '123', channelId: '456' },
		}),
	).resolves.toMatchObject({ status: 'enqueued' })
	expect(send).toHaveBeenCalledTimes(1)
})

test('package events deliver with filters, idempotent replay, and retryable failures', async () => {
	const db = createDatabase()
	const { manifests, sources } = seedRuntimeDispatchPackages()
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
	const message = {
		userId: 'user-123',
		topic: '@kentcdodds/discord.message.created',
		idempotencyKey: 'discord:message-create:123',
		payload: {
			messageId: '123',
			channelId: '456',
		},
		source: {
			packageId: 'pkg-gateway',
			kodyId: 'discord-gateway',
		},
		invokeDepth: 1,
	}

	const first = await deliverPackageEvent({
		env: createEnv(db),
		baseUrl: 'https://kody.dev',
		message,
	})
	const second = await deliverPackageEvent({
		env: createEnv(db),
		baseUrl: 'https://kody.dev',
		message,
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
	await expect(
		deliverPackageEvent({
			env: createEnv(db),
			baseUrl: 'https://kody.dev',
			message: { ...message, idempotencyKey: 'discord:manifest-error' },
		}),
	).rejects.toThrow(
		/Failed to load package manifest for package event dispatch/,
	)

	const filteredSeed = seedRuntimeDispatchPackages()
	const subscriberManifest = filteredSeed.manifests.get(
		'source-subscriber',
	) as {
		kody: {
			subscriptions?: Record<
				string,
				{ handler: string; filters?: Record<string, unknown> }
			>
		}
	}
	subscriberManifest.kody.subscriptions = {
		'@kentcdodds/discord.message.created': {
			handler: './src/handle-discord-message-created.ts',
			filters: { channelId: '456' },
		},
	}
	const subscriberFiles = filteredSeed.sourceFiles.get('source-subscriber')
	if (subscriberFiles) {
		subscriberFiles['package.json'] = JSON.stringify(subscriberManifest)
	}
	repoMockModule.runBundledModuleWithRegistry.mockClear()
	repoMockModule.runBundledModuleWithRegistry.mockResolvedValue({
		result: { handled: true },
		logs: [],
	})
	const baseMessage = {
		userId: 'user-123',
		topic: '@kentcdodds/discord.message.created',
		payload: {},
		source: {
			packageId: 'pkg-gateway',
			kodyId: 'discord-gateway',
		},
		invokeDepth: 1,
	}
	const filteredOut = await deliverPackageEvent({
		env: createEnv(db),
		baseUrl: 'https://kody.dev',
		message: {
			...baseMessage,
			idempotencyKey: 'discord:other-channel',
			payload: { messageId: '1', channelId: '999' },
		},
	})
	expect(filteredOut).toMatchObject({ delivered: 0, failed: 0 })
	expect(filteredOut.subscribers).toEqual([])
	expect(repoMockModule.runBundledModuleWithRegistry).not.toHaveBeenCalled()
	const matching = await deliverPackageEvent({
		env: createEnv(db),
		baseUrl: 'https://kody.dev',
		message: {
			...baseMessage,
			idempotencyKey: 'discord:matching-channel',
			payload: { messageId: '2', channelId: '456' },
		},
	})
	expect(matching).toMatchObject({ delivered: 1, failed: 0 })
	expect(repoMockModule.runBundledModuleWithRegistry).toHaveBeenCalledTimes(1)

	const claimDb = createDatabase({ failClaim: true })
	seedRuntimeDispatchPackages()
	repoMockModule.runBundledModuleWithRegistry.mockClear()
	consoleError.mockImplementation(() => {})
	await expect(
		deliverPackageEvent({
			env: createEnv(claimDb),
			baseUrl: 'https://kody.dev',
			message: {
				...baseMessage,
				idempotencyKey: 'discord:message-create:claim-failure',
				payload: { messageId: '1' },
			},
		}),
	).rejects.toThrow('Package event dispatch was incomplete.')
	expect(repoMockModule.runBundledModuleWithRegistry).not.toHaveBeenCalled()
})

test('package events fall back to inline delivery without a queue binding', async () => {
	const db = createDatabase()
	seedRuntimeDispatchPackages()
	repoMockModule.runBundledModuleWithRegistry.mockClear()
	repoMockModule.runBundledModuleWithRegistry.mockResolvedValue({
		result: { handled: true },
		logs: [],
	})
	const tools = createRuntimeEventTools(db)

	const result = await tools.dispatch({
		topic: '@kentcdodds/discord.message.created',
		idempotencyKey: 'discord:message-create:inline',
		payload: { messageId: 'inline-1' },
	})

	expect(result).toMatchObject({ status: 'delivered_inline' })
	expect(repoMockModule.runBundledModuleWithRegistry).toHaveBeenCalledTimes(1)
	expect(
		repoMockModule.runBundledModuleWithRegistry.mock.calls[0]?.[3],
	).toMatchObject({
		event: '@kentcdodds/discord.message.created',
		payload: { messageId: 'inline-1' },
	})

	// Inline delivery failures are logged, never surfaced to the emitter.
	const { manifests, sources } = seedRuntimeDispatchPackages()
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
	consoleError.mockImplementation(() => {})
	await expect(
		tools.dispatch({
			topic: '@kentcdodds/discord.message.created',
			idempotencyKey: 'discord:message-create:inline-error',
			payload: { messageId: 'inline-2' },
		}),
	).resolves.toMatchObject({ status: 'delivered_inline' })
	expect(consoleError).toHaveBeenCalledWith(
		'package-events-inline-delivery-failed',
		expect.objectContaining({
			topic: '@kentcdodds/discord.message.created',
		}),
	)
})

test('package runtime invoke contract-checks once and executes the target', async () => {
	const db = createDatabase()
	seedRuntimeDispatchPackages()
	repoMockModule.runBundledModuleWithRegistry.mockResolvedValue({
		result: { handled: true, eventId: 'message-1' },
		logs: [],
	})
	repoMockModule.loadPackageManifestForSource.mockClear()
	const tools = createRuntimeDispatchTools(db)

	const result = await tools.invoke({
		specifier: 'kody:@kentcdodds/discord-general-chat',
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
	repoMockModule.recordAgentPackageConversationUse.mockClear()
	repoMockModule.recordAgentPackageConversationUse.mockResolvedValue(undefined)
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

	repoMockModule.runBundledModuleWithRegistry.mockClear()
	await expect(
		tools.invoke({
			specifier: 'kody:@kentcdodds/missing-package',
			options: {
				exportName: './handle-discord-message-created',
				params: {},
			},
		}),
	).rejects.toThrow(
		'packages.invoke contract check failed: Kody package specifier "kody:@kentcdodds/missing-package" could not be resolved for this caller.',
	)
	await expect(
		tools.invoke({
			specifier: 'kody:@kentcdodds/discord-general-chat',
			options: { exportName: './missing-export', params: {} },
		}),
	).rejects.toThrow(
		'packages.invoke contract check failed: Package "discord-general-chat" does not define export "./missing-export".',
	)
	await expect(
		tools.invoke({
			specifier: 'kody:@kentcdodds/discord-general-chat',
			options: {
				exportName: './handle-discord-message-created',
				params: 'not-an-object',
			},
		} as never),
	).rejects.toThrow(
		'packages.invoke params must be a JSON object when provided.',
	)
	expect(repoMockModule.runBundledModuleWithRegistry).not.toHaveBeenCalled()

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
			parentRunRecord: {
				packageId: 'pkg-gateway',
				kodyId: 'discord-gateway',
				sourceId: 'source-gateway',
				surface: 'export',
				name: './dispatch-message-created',
				idempotencyKey: 'message-1',
			},
			packageInvokeDepth: 0,
		})

	repoMockModule.getSavedPackageByName.mockResolvedValueOnce(null)
	await expect(
		createTools().invoke({
			specifier: 'kody:@kentcdodds/missing-package',
			options: { exportName: './handle-discord-message-created' },
		}),
	).rejects.toThrow(
		'packages.invoke contract check failed: Kody package specifier "kody:@kentcdodds/missing-package" could not be resolved for this caller.',
	)

	seedRuntimeDispatchPackages()
	await expect(
		createTools().invoke({
			specifier: 'kody:@kentcdodds/discord-general-chat',
			options: {
				exportName: './missing-export',
				params: { event: { id: 'message-1' } },
			},
		}),
	).rejects.toThrow(
		'packages.invoke contract check failed: Package "discord-general-chat" does not define export "./missing-export".',
	)
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
			parentRunRecord: {
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
		specifier: 'kody:@kentcdodds/discord-general-chat',
		options: {
			exportName: './handle-discord-message-created',
			params: { marker: 'same-child-call', value: 1 },
		},
	})
	const second = await createToolsForParent('./second-parent').invoke({
		specifier: 'kody:@kentcdodds/discord-general-chat',
		options: {
			exportName: './handle-discord-message-created',
			params: { marker: 'same-child-call', value: 1 },
		},
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
			specifier: 'kody:@kentcdodds/discord-general-chat',
			options: { exportName: './handle-discord-message-created' },
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
			specifier: 'kody:@kentcdodds/discord-general-chat',
			options: { exportName: './handle-discord-message-created' },
		}),
	).rejects.toThrow(
		'packages.invoke exceeded the maximum nested invocation depth (8).',
	)
})
