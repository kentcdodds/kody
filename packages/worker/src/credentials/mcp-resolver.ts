/**
 * Resolver for a connected MCP server. The server row id is the credential
 * id. The handle exposes `callTool`; the hub holds the connection's tokens.
 */
import { callMcpServerTool } from '#worker/mcp-client/hub-client.ts'
import { assertCanUseMcpServer } from '#worker/mcp-client/package-access.ts'
import {
	authorizeActorUse,
	type CredentialResolver,
} from './credential-resolver.ts'

export const mcpConnectionResolver: CredentialResolver<'mcp-connection'> = {
	auditSubject: (credential) => ({
		use: credential.use,
		resourceType: 'mcp-server',
		name: credential.serverName,
		credentialId: credential.serverId,
		details: { serverId: credential.serverId },
	}),
	async resolve(call) {
		const { input, credential } = call
		return {
			async authorize() {
				await authorizeActorUse(call, credential.serverId)
				await assertCanUseMcpServer({
					env: input.env,
					baseUrl: input.baseUrl,
					userId: input.orgId,
					serverId: credential.serverId,
					serverName: credential.serverName,
					packageId: input.packageStamp?.packageId ?? null,
				})
			},
			async apply() {
				return {
					async callTool(toolCall) {
						return await callMcpServerTool({
							env: input.env,
							userId: input.orgId,
							waitUntil: credential.waitUntil,
							serverId: credential.serverId,
							toolName: toolCall.toolName,
							args: toolCall.args,
						})
					},
				}
			},
		}
	},
	isFound: () => true,
}
