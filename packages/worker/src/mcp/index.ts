import * as Sentry from '@sentry/cloudflare'
import { type exports as workerExports } from 'cloudflare:workers'
import { invariant } from '@epic-web/invariant'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { CfWorkerJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/cfworker-provider.js'
import { McpAgent } from 'agents/mcp'
import { buildSentryOptions } from '../sentry-options.ts'
import { parseMcpCallerContext, type McpServerProps } from './context.ts'
import { registerResources } from './register-resources.ts'
import {
	buildMcpServerInstructions,
	conversationIdGuidance,
	type RemoteConnectorInstructionSummary,
} from './server-instructions.ts'
import { registerTools } from './register-tools.ts'
import { getMcpUserServerInstructions } from './user-server-instructions-repo.ts'
import { createRemoteConnectorMcpClient } from '#worker/remote-connector/client.ts'
import { remoteConnectorDomainId } from '#worker/remote-connector/remote-domain-id.ts'
import { normalizeRemoteConnectorRefs } from '@kody-internal/shared/remote-connectors.ts'
import { type McpCallerContext } from '@kody-internal/shared/chat.ts'

export type State = {
	searchConversationIdsWithPreamble?: Array<string>
}
export type Props = McpServerProps

export { conversationIdGuidance }

const serverImplementation = {
	name: 'kody-mcp',
	version: '1.0.0',
} as const

async function loadRemoteConnectorInstructionSummaries(input: {
	env: Env
	caller: McpCallerContext
}): Promise<Array<RemoteConnectorInstructionSummary>> {
	const refs = normalizeRemoteConnectorRefs(input.caller)
	const userId = input.caller.user?.userId ?? null
	if (refs.length === 0 || !userId) {
		return []
	}
	const settled = await Promise.allSettled(
		refs.map(async (ref) => {
			const snapshot = await createRemoteConnectorMcpClient({
				env: input.env,
				userId,
				kind: ref.kind,
				instanceId: ref.instanceId,
			}).getSnapshot()
			if (!snapshot) return null
			const connectorKind = snapshot.connectorKind.trim().toLowerCase()
			const connectorId = snapshot.connectorId.trim()
			return {
				name: `${connectorKind}/${connectorId}`,
				domain: remoteConnectorDomainId(ref),
				description: snapshot.description ?? null,
			}
		}),
	)
	return settled.flatMap((outcome, index) => {
		if (outcome.status === 'fulfilled') {
			return outcome.value ? [outcome.value] : []
		}
		const ref = refs[index]
		console.error(
			`[loadRemoteConnectorInstructionSummaries] failed for ${ref?.kind ?? '?'}:${ref?.instanceId ?? '?'}`,
			outcome.reason,
		)
		return []
	})
}

class MCPBase extends McpAgent<Env, State, Props> {
	initialState: State = {
		searchConversationIdsWithPreamble: [],
	}
	declare server: McpServer
	async init() {
		const caller = this.getCallerContext()
		const userId = caller.user?.userId ?? null
		const [overlay, remoteConnectors] = await Promise.all([
			userId !== null
				? getMcpUserServerInstructions(this.env.APP_DB, userId)
				: Promise.resolve(null),
			loadRemoteConnectorInstructionSummaries({
				env: this.env,
				caller,
			}),
		])
		this.server = new McpServer(serverImplementation, {
			instructions: buildMcpServerInstructions({
				userOverlay: overlay,
				remoteConnectors,
			}),
			jsonSchemaValidator: new CfWorkerJsonSchemaValidator(),
		})
		await registerResources(this)
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
