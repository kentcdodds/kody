import * as Sentry from '@sentry/cloudflare'
import { type exports as workerExports } from 'cloudflare:workers'
import { invariant } from '@epic-web/invariant'
import { type McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { CfWorkerJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/cfworker-provider.js'
import { McpAgent } from 'agents/mcp'
import { buildSentryOptions } from '../sentry-options.ts'
import { parseMcpCallerContext, type McpServerProps } from './context.ts'
import {
	buildMcpServerInstructions,
	conversationIdGuidance,
	type RemoteConnectorInstructionSummary,
} from './server-instructions.ts'
import { registerTools } from './register-tools.ts'
import { createKodyMcpServer } from './sentry-mcp-server.ts'
import { getMcpUserServerInstructions } from './user-server-instructions-repo.ts'
import { getCapabilityRegistryForContext } from './capabilities/registry.ts'
import { createRemoteConnectorMcpClient } from '#worker/remote-connector/client.ts'
import { remoteConnectorDomainId } from '#worker/remote-connector/remote-domain-id.ts'
import { normalizeRemoteConnectorRefs } from '@kody-internal/shared/remote-connectors.ts'
import { type McpCallerContext } from '@kody-internal/shared/chat.ts'

export type State = {
	searchConversationIdsWithPreamble?: Array<string>
}
export type Props = McpServerProps

export { conversationIdGuidance }

async function loadRemoteConnectorInstructionSummaries(input: {
	env: Env
	caller: McpCallerContext
}): Promise<Array<RemoteConnectorInstructionSummary>> {
	const refs = normalizeRemoteConnectorRefs(input.caller)
	const userId = input.caller.user?.userId ?? null
	if (refs.length === 0 || !userId) {
		return []
	}
	const snapshots = await Promise.all(
		refs.map(async (ref) => {
			const snapshot = await createRemoteConnectorMcpClient({
				env: input.env,
				userId,
				instanceId: ref.instanceId,
			}).getSnapshot()
			if (!snapshot) return null
			const connectorId = snapshot.connectorId.trim()
			return {
				name: connectorId,
				domain: remoteConnectorDomainId(ref),
				description: snapshot.description ?? null,
			}
		}),
	)
	return snapshots.flatMap((snapshot) => (snapshot ? [snapshot] : []))
}

class MCPBase extends McpAgent<Env, State, Props> {
	initialState: State = {
		searchConversationIdsWithPreamble: [],
	}
	declare server: McpServer
	async init() {
		const caller = this.getCallerContext()
		const userId = caller.user?.userId ?? null
		const [overlay, remoteConnectors, registry] = await Promise.all([
			userId !== null
				? getMcpUserServerInstructions(this.env.APP_DB, userId)
				: Promise.resolve(null),
			loadRemoteConnectorInstructionSummaries({
				env: this.env,
				caller,
			}),
			getCapabilityRegistryForContext({
				env: this.env,
				callerContext: caller,
			}),
		])
		this.server = createKodyMcpServer({
			instructions: buildMcpServerInstructions({
				userOverlay: overlay,
				domains: registry.capabilityDomains,
				remoteConnectors,
			}),
			jsonSchemaValidator: new CfWorkerJsonSchemaValidator(),
		})
		await registerTools(this)
	}
	getCallerContext() {
		return parseMcpCallerContext(this.props)
	}
	getEnv() {
		return this.env
	}
	getLoopbackExports() {
		return this.ctx.exports as typeof workerExports
	}
	requireDomain() {
		const { baseUrl } = this.getCallerContext()
		invariant(
			baseUrl,
			'This should never happen, but somehow we did not get the baseUrl from the request handler',
		)
		return baseUrl
	}
}

export const MCP = Sentry.instrumentDurableObjectWithSentry(
	(env: Env) => buildSentryOptions(env),
	MCPBase,
)

/** Agent instance type for tool/resource registration (the Durable Object export is a wrapped class). */
export type MCP = InstanceType<typeof MCP>
