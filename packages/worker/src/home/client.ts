import { type CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { connectorSessionKey } from '#worker/remote-connector/connector-session-key.ts'
import { type HomeConnectorSnapshot, type HomeToolDescriptor } from './types.ts'

export type HomeMcpTool = HomeToolDescriptor

export type HomeMcpClient = {
	listTools(): Promise<Array<HomeMcpTool>>
	callTool(
		name: string,
		args?: Record<string, unknown>,
	): Promise<CallToolResult>
	getSnapshot(): Promise<HomeConnectorSnapshot | null>
}

function getSessionStub(env: Env, kind: string, instanceId: string) {
	const sessionKey = connectorSessionKey(kind, instanceId)
	return env.HOME_CONNECTOR_SESSION.get(
		env.HOME_CONNECTOR_SESSION.idFromName(sessionKey),
	)
}

export function createRemoteConnectorMcpClient(
	env: Env,
	kind: string,
	instanceId: string,
): HomeMcpClient {
	const stub = getSessionStub(env, kind, instanceId)

	return {
		async listTools() {
			return stub.rpcListTools()
		},
		async callTool(name, args) {
			return (await stub.rpcCallTool(name, args ?? {})) as CallToolResult
		},
		async getSnapshot() {
			return stub.getSnapshot()
		},
	}
}

export function createHomeMcpClient(
	env: Env,
	connectorId: string,
): HomeMcpClient {
	return createRemoteConnectorMcpClient(env, 'home', connectorId)
}
