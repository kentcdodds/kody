import { type CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { PromiseLruCache } from '#worker/package-registry/published-package-cache.ts'
import {
	type McpClientHubSnapshot,
	type McpServerConnectResult,
	type McpServerOAuthCallbackOutcome,
} from './types.ts'

export const mcpClientHubSnapshotCacheTtlMs = 30_000
export const mcpClientHubSnapshotCacheLimit = 100

export function mcpClientHubKey(userId: string) {
	return userId.trim()
}

function getMcpClientHubStub(input: { env: Env; userId: string }) {
	const key = mcpClientHubKey(input.userId)
	return input.env.MCP_CLIENT_HUB.get(input.env.MCP_CLIENT_HUB.idFromName(key))
}

export type McpClientHubClient = {
	addServer(input: {
		serverId: string
		name: string
		url: string
		callbackUrl: string
	}): Promise<McpServerConnectResult>
	reconnectServer(input: { serverId: string }): Promise<McpServerConnectResult>
	refreshServer(input: { serverId: string }): Promise<McpServerConnectResult>
	removeServer(input: { serverId: string }): Promise<void>
	handleOAuthCallback(input: {
		url: string
	}): Promise<McpServerOAuthCallbackOutcome>
	getSnapshot(): Promise<McpClientHubSnapshot>
	callTool(input: {
		serverId: string
		toolName: string
		args: Record<string, unknown>
	}): Promise<CallToolResult>
}

export function createMcpClientHubClient(input: {
	env: Env
	userId: string
}): McpClientHubClient {
	const stub = getMcpClientHubStub(input)
	return {
		async addServer(addInput) {
			invalidateMcpClientHubSnapshotCache(input)
			return await stub.addServer(addInput)
		},
		async reconnectServer(reconnectInput) {
			invalidateMcpClientHubSnapshotCache(input)
			return await stub.reconnectServer(reconnectInput)
		},
		async refreshServer(refreshInput) {
			invalidateMcpClientHubSnapshotCache(input)
			return await stub.refreshServer(refreshInput)
		},
		async removeServer(removeInput) {
			invalidateMcpClientHubSnapshotCache(input)
			await stub.removeServer(removeInput)
		},
		async handleOAuthCallback(callbackInput) {
			invalidateMcpClientHubSnapshotCache(input)
			return await stub.handleOAuthCallback(callbackInput)
		},
		async getSnapshot() {
			return getCachedMcpClientHubSnapshot(input)
		},
		async callTool(callInput) {
			try {
				return (await stub.callTool(callInput)) as CallToolResult
			} catch (error) {
				invalidateMcpClientHubSnapshotCache(input)
				throw error
			}
		},
	}
}

function createMcpClientHubSnapshotCache() {
	return new PromiseLruCache<McpClientHubSnapshot>({
		ttlMs: mcpClientHubSnapshotCacheTtlMs,
		limit: mcpClientHubSnapshotCacheLimit,
	})
}

let mcpClientHubSnapshotCache = createMcpClientHubSnapshotCache()

export function getCachedMcpClientHubSnapshot(input: {
	env: Env
	userId: string
}): Promise<McpClientHubSnapshot> {
	const cacheKey = mcpClientHubKey(input.userId)
	return mcpClientHubSnapshotCache.getOrCreate({
		cacheKey,
		create: async () => {
			const stub = getMcpClientHubStub(input)
			return await stub.getSnapshot()
		},
	})
}

export function invalidateMcpClientHubSnapshotCache(input: { userId: string }) {
	mcpClientHubSnapshotCache.delete(mcpClientHubKey(input.userId))
}

export function clearMcpClientHubSnapshotCacheForTests() {
	mcpClientHubSnapshotCache = createMcpClientHubSnapshotCache()
}
