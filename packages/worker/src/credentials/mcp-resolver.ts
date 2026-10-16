/**
 * Resolver for a connected MCP server. The server row id is the credential
 * id. The handle exposes `callTool`; the hub holds the connection's tokens.
 * Each invocation of that handle writes one `mcp.call` audit row. The
 * connection decision stays on the door's single `credential.resolve` row.
 */
import { callMcpServerTool } from '#worker/mcp-client/hub-client.ts'
import { assertCanUseMcpServer } from '#worker/mcp-client/package-access.ts'
import {
	mcpCallErrorClass,
	mcpCallOutcomeFromResult,
	scheduleMcpCallAudit,
	type McpCallAuditOutcome,
} from './mcp-call-audit.ts'
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
						const startedAt = performance.now()
						const audit = (outcome: McpCallAuditOutcome) => {
							scheduleMcpCallAudit({
								env: input.env,
								orgId: input.orgId,
								actor: input.actor,
								packageStamp: input.packageStamp,
								serverId: credential.serverId,
								serverName: credential.serverName,
								toolName: toolCall.toolName,
								durationMs: performance.now() - startedAt,
								outcome,
							})
						}
						try {
							const result = await callMcpServerTool({
								env: input.env,
								userId: input.orgId,
								waitUntil: credential.waitUntil,
								serverId: credential.serverId,
								toolName: toolCall.toolName,
								args: toolCall.args,
							})
							// A caller's accept() can still reject the payload
							// (malformed or oversized content). That rejection
							// is the outcome the caller sees, so it is the
							// audit result. accept() must not keep the body.
							toolCall.accept?.(result)
							audit(mcpCallOutcomeFromResult(result))
							return result
						} catch (error) {
							audit({
								result: 'failure',
								errorClass: mcpCallErrorClass(error),
							})
							throw error
						}
					},
				}
			},
		}
	},
	isFound: () => true,
}
