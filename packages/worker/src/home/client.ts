import { type CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import {
	connectorIngressPath,
	connectorSessionKey,
} from '#worker/remote-connector/connector-session-key.ts'
import { internalCallHeaders } from './internal-call-token.ts'
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

function createSessionUrl(
	kind: string,
	instanceId: string,
	pathname: string,
): string {
	const base = connectorIngressPath(kind, instanceId)
	return `https://home-connectors${base}${pathname}`
}

function getSessionStub(env: Env, kind: string, instanceId: string) {
	const sessionKey = connectorSessionKey(kind, instanceId)
	return env.HOME_CONNECTOR_SESSION.get(
		env.HOME_CONNECTOR_SESSION.idFromName(sessionKey),
	)
}

async function parseJsonResponse<T>(response: Response): Promise<T> {
	if (!response.ok) {
		throw new Error(await response.text())
	}
	return (await response.json()) as T
}

export function createRemoteConnectorMcpClient(
	env: Env,
	kind: string,
	instanceId: string,
): HomeMcpClient {
	const stub = getSessionStub(env, kind, instanceId)

	return {
		async listTools() {
			const response = await stub.fetch(
				createSessionUrl(kind, instanceId, '/rpc/tools-list'),
				{
					method: 'POST',
					headers: internalCallHeaders(),
				},
			)
			const result = await parseJsonResponse<{ tools?: Array<HomeMcpTool> }>(
				response,
			)
			return result.tools ?? []
		},
		async callTool(name, args) {
			const response = await stub.fetch(
				createSessionUrl(kind, instanceId, '/rpc/tools-call'),
				{
					method: 'POST',
					headers: {
						'Content-Type': 'application/json',
						...internalCallHeaders(),
					},
					body: JSON.stringify({
						name,
						arguments: args ?? {},
					}),
				},
			)
			return parseJsonResponse<CallToolResult>(response)
		},
		async getSnapshot() {
			const response = await stub.fetch(
				createSessionUrl(kind, instanceId, '/snapshot'),
				{ headers: internalCallHeaders() },
			)
			return parseJsonResponse<HomeConnectorSnapshot | null>(response)
		},
	}
}

export function createHomeMcpClient(
	env: Env,
	connectorId: string,
): HomeMcpClient {
	return createRemoteConnectorMcpClient(env, 'home', connectorId)
}
