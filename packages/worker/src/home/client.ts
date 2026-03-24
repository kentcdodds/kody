import { type CallToolResult } from '@modelcontextprotocol/sdk/types.js'
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

function createSessionUrl(connectorId: string, pathname: string): string {
	return `https://home-connectors/${connectorId}${pathname}`
}

function getSessionStub(env: Env, connectorId: string) {
	return env.HOME_CONNECTOR_SESSION.get(
		env.HOME_CONNECTOR_SESSION.idFromName(connectorId),
	)
}

async function parseJsonResponse<T>(response: Response): Promise<T> {
	if (!response.ok) {
		throw new Error(await response.text())
	}
	return (await response.json()) as T
}

export function createHomeMcpClient(
	env: Env,
	connectorId: string,
): HomeMcpClient {
	const stub = getSessionStub(env, connectorId)

	return {
		async listTools() {
			const response = await stub.fetch(
				createSessionUrl(connectorId, '/rpc/tools-list'),
				{
					method: 'POST',
				},
			)
			const result = await parseJsonResponse<{ tools?: Array<HomeMcpTool> }>(
				response,
			)
			return result.tools ?? []
		},
		async callTool(name, args) {
			const response = await stub.fetch(
				createSessionUrl(connectorId, '/rpc/tools-call'),
				{
					method: 'POST',
					headers: {
						'Content-Type': 'application/json',
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
				createSessionUrl(connectorId, '/snapshot'),
			)
			return parseJsonResponse<HomeConnectorSnapshot | null>(response)
		},
	}
}
