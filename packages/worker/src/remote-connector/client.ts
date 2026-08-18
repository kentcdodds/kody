import { type CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { userScopedConnectorSessionKey } from '#worker/remote-connector/connector-session-key.ts'
import {
	getCachedRemoteConnectorSnapshot,
	invalidateRemoteConnectorSnapshotCache,
} from '#worker/remote-connector/snapshot-cache.ts'
import {
	remoteConnectorRpcTimeoutMessage,
	remoteConnectorRpcTimeoutMs,
} from './rpc-timeout.ts'
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

async function withRemoteConnectorRpcTimeout<T>(
	operation: () => Promise<T>,
	method: string,
): Promise<T> {
	let timeoutId: ReturnType<typeof setTimeout> | undefined
	try {
		return await Promise.race([
			operation(),
			new Promise<never>((_resolve, reject) => {
				timeoutId = setTimeout(() => {
					reject(new Error(remoteConnectorRpcTimeoutMessage(method)))
				}, remoteConnectorRpcTimeoutMs)
			}),
		])
	} finally {
		if (timeoutId !== undefined) {
			clearTimeout(timeoutId)
		}
	}
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
				return await withRemoteConnectorRpcTimeout(
					() => stub.rpcListTools(),
					'tools/list',
				)
			} catch (error) {
				invalidateSnapshotOnFailure(error)
			}
		},
		async callTool(name, args) {
			try {
				return (await withRemoteConnectorRpcTimeout(
					() => stub.rpcCallTool(name, args ?? {}),
					'tools/call',
				)) as CallToolResult
			} catch (error) {
				invalidateSnapshotOnFailure(error)
			}
		},
		async getSnapshot() {
			return getCachedRemoteConnectorSnapshot(input)
		},
	}
}
