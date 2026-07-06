import { type CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { userScopedConnectorSessionKey } from '#worker/remote-connector/connector-session-key.ts'
import {
	getCachedRemoteConnectorSnapshot,
	invalidateRemoteConnectorSnapshotCache,
} from '#worker/remote-connector/snapshot-cache.ts'
import {
	type RemoteConnectorSnapshot,
	type RemoteConnectorToolDescriptor,
} from './types.ts'

export type RemoteConnectorMcpTool = RemoteConnectorToolDescriptor

export type RemoteConnectorMcpClient = {
	listTools(): Promise<Array<RemoteConnectorMcpTool>>
	callTool(
		name: string,
		args?: Record<string, unknown>,
	): Promise<CallToolResult>
	getSnapshot(): Promise<RemoteConnectorSnapshot | null>
}

function getSessionStub(input: {
	env: Env
	userId: string
	instanceId: string
}) {
	const sessionKey = userScopedConnectorSessionKey({
		userId: input.userId,
		instanceId: input.instanceId,
	})
	return input.env.REMOTE_CONNECTOR_SESSION.get(
		input.env.REMOTE_CONNECTOR_SESSION.idFromName(sessionKey),
	)
}

export function createRemoteConnectorMcpClient(input: {
	env: Env
	userId: string
	instanceId: string
}): RemoteConnectorMcpClient {
	const stub = getSessionStub(input)

	// A failed RPC usually means the connector dropped since the snapshot was
	// cached, so evict it instead of serving a stale "connected" view for the
	// rest of the TTL.
	function invalidateSnapshotOnFailure(error: unknown): never {
		invalidateRemoteConnectorSnapshotCache(input)
		throw error
	}

	return {
		async listTools() {
			try {
				return await stub.rpcListTools()
			} catch (error) {
				invalidateSnapshotOnFailure(error)
			}
		},
		async callTool(name, args) {
			try {
				return (await stub.rpcCallTool(name, args ?? {})) as CallToolResult
			} catch (error) {
				invalidateSnapshotOnFailure(error)
			}
		},
		async getSnapshot() {
			return getCachedRemoteConnectorSnapshot(input)
		},
	}
}
