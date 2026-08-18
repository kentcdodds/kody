import { type CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { PromiseLruCache } from '#worker/package-registry/published-package-cache.ts'
import { mcpClientHubDurableObjectName } from '#worker/user-scoped-durable-object-name.ts'
import { type McpServerConnectionEvent } from './connection-episodes.ts'
import {
	type McpClientHubSnapshot,
	type McpServerConnectResult,
	type McpServerOAuthCallbackOutcome,
} from './types.ts'

export const mcpClientHubSnapshotCacheTtlMs = 30_000
export const mcpClientHubSnapshotCacheLimit = 100

type McpClientHubClientInput = {
	env: Env
	userId: string
	waitUntil?: (promise: Promise<unknown>) => void
}

/** Cache/DO key alias for {@link mcpClientHubDurableObjectName}. */
export function mcpClientHubKey(userId: string) {
	return mcpClientHubDurableObjectName(userId)
}

function getMcpClientHubStub(input: { env: Env; userId: string }) {
	const key = mcpClientHubDurableObjectName(input.userId)
	return input.env.MCP_CLIENT_HUB.get(input.env.MCP_CLIENT_HUB.idFromName(key))
}

async function emitMcpServerConnectionEvents(input: {
	env: Env
	userId: string
	events: Array<McpServerConnectionEvent>
	waitUntil?: (promise: Promise<unknown>) => void
}) {
	if (input.events.length === 0) return
	const { emitMcpServerConnectionEventsIfNeeded } =
		await import('./package-subscriptions.ts')
	await emitMcpServerConnectionEventsIfNeeded(input)
}

export type McpClientHubClient = {
	addServer(input: {
		serverId: string
		name: string
		url: string
		callbackUrl: string
		headers?: Record<string, string>
	}): Promise<McpServerConnectResult>
	reconnectServer(input: {
		serverId: string
		callbackUrl: string
	}): Promise<McpServerConnectResult>
	refreshServer(input: { serverId: string }): Promise<McpServerConnectResult>
	removeServer(input: { serverId: string }): Promise<void>
	handleOAuthCallback(input: {
		url: string
		callbackUrl: string
	}): Promise<McpServerOAuthCallbackOutcome>
	getSnapshot(): Promise<McpClientHubSnapshot>
	callTool(input: {
		serverId: string
		toolName: string
		args: Record<string, unknown>
	}): Promise<CallToolResult>
}

export function createMcpClientHubClient(
	input: McpClientHubClientInput,
): McpClientHubClient {
	const stub = getMcpClientHubStub(input)
	return {
		async addServer(addInput) {
			invalidateMcpClientHubSnapshotCache(input)
			const result = await stub.addServer(addInput)
			await emitTakenConnectionEvents(input, stub)
			return result
		},
		async reconnectServer(reconnectInput) {
			invalidateMcpClientHubSnapshotCache(input)
			const result = await stub.reconnectServer(reconnectInput)
			await emitTakenConnectionEvents(input, stub)
			return result
		},
		async refreshServer(refreshInput) {
			invalidateMcpClientHubSnapshotCache(input)
			const result = await stub.refreshServer(refreshInput)
			await emitTakenConnectionEvents(input, stub)
			return result
		},
		async removeServer(removeInput) {
			invalidateMcpClientHubSnapshotCache(input)
			await stub.removeServer(removeInput)
		},
		async handleOAuthCallback(callbackInput) {
			invalidateMcpClientHubSnapshotCache(input)
			const result = await stub.handleOAuthCallback(callbackInput)
			await emitTakenConnectionEvents(input, stub)
			return result
		},
		async getSnapshot() {
			return getCachedMcpClientHubSnapshot(input)
		},
		async callTool(callInput) {
			try {
				const result = (await stub.callTool(callInput)) as CallToolResult
				await emitTakenConnectionEvents(input, stub)
				return result
			} catch (error) {
				invalidateMcpClientHubSnapshotCache(input)
				await emitTakenConnectionEvents(input, stub)
				throw error
			}
		},
	}
}

async function emitTakenConnectionEvents(
	input: McpClientHubClientInput,
	stub: ReturnType<typeof getMcpClientHubStub>,
) {
	const events =
		(await stub.takeConnectionEvents()) as Array<McpServerConnectionEvent>
	await emitMcpServerConnectionEvents({
		env: input.env,
		userId: input.userId,
		events,
		waitUntil: input.waitUntil,
	})
}

function createMcpClientHubSnapshotCache() {
	return new PromiseLruCache<McpClientHubSnapshot>({
		ttlMs: mcpClientHubSnapshotCacheTtlMs,
		limit: mcpClientHubSnapshotCacheLimit,
	})
}

let mcpClientHubSnapshotCache = createMcpClientHubSnapshotCache()

export function getCachedMcpClientHubSnapshot(
	input: McpClientHubClientInput,
): Promise<McpClientHubSnapshot> {
	const cacheKey = mcpClientHubKey(input.userId)
	return mcpClientHubSnapshotCache.getOrCreate({
		cacheKey,
		create: async () => {
			const stub = getMcpClientHubStub(input)
			const snapshot = await stub.getSnapshot()
			await emitMcpServerConnectionEvents({
				env: input.env,
				userId: input.userId,
				events: snapshot.connectionEvents ?? [],
				waitUntil: input.waitUntil,
			})
			return { servers: snapshot.servers }
		},
	})
}

export function invalidateMcpClientHubSnapshotCache(input: { userId: string }) {
	mcpClientHubSnapshotCache.delete(mcpClientHubKey(input.userId))
}

export function clearMcpClientHubSnapshotCacheForTests() {
	mcpClientHubSnapshotCache = createMcpClientHubSnapshotCache()
}
