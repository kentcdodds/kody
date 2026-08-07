import * as Sentry from '@sentry/cloudflare'
import { type exports as workerExports } from 'cloudflare:workers'
import { invariant } from '@epic-web/invariant'
import { type McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { CfWorkerJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/cfworker-provider.js'
import { McpAgent } from 'agents/mcp'
import { buildSentryOptions } from '../sentry-options.ts'
import { parseMcpCallerContext, type McpServerProps } from './context.ts'
import { buildMcpServerInstructions } from './server-instructions.ts'
import { registerTools } from './register-tools.ts'
import {
	asMcpToolServer,
	type McpRegistrationAgent,
} from './mcp-registration-agent.ts'
import { createKodyMcpServer } from './sentry-mcp-server.ts'
import { getMcpUserServerInstructions } from './user-server-instructions-repo.ts'
import { getCapabilityRegistryForContext } from './capabilities/registry.ts'
import { type RawFetchHostNudgeState } from '#mcp/raw-fetch-host-nudge.ts'
import { listPopularAgentPackagesForUser } from '#worker/usage/agent-package-conversation-uses.ts'
import {
	purgePersistedMcpAgentSession,
	registerMcpAgentSession,
} from './session-registry.ts'

export type State = {
	searchConversationIdsWithPreamble?: Array<string>
	onboardingNoticeConversationIds?: Array<string>
	onboardingNoticeLastShownAtMs?: number
	rawFetchHostNudges?: RawFetchHostNudgeState
}
export type Props = McpServerProps

class MCPBase extends McpAgent<Env, State, Props> {
	initialState: State = {
		searchConversationIdsWithPreamble: [],
		onboardingNoticeConversationIds: [],
		rawFetchHostNudges: {
			conversationOrder: [],
			byConversation: {},
		},
	}
	declare server: McpServer
	async init() {
		const caller = this.getCallerContext()
		const userId = caller.user?.userId ?? null
		if (userId !== null) {
			await registerMcpAgentSession({
				db: this.env.APP_DB,
				userId,
				doId: this.ctx.id.toString(),
			})
		}
		const [overlay, registry, popularPackages] = await Promise.all([
			userId !== null
				? getMcpUserServerInstructions(this.env.APP_DB, userId)
				: Promise.resolve(null),
			getCapabilityRegistryForContext({
				env: this.env,
				callerContext: caller,
			}),
			userId !== null
				? listPopularAgentPackagesForUser(this.env.APP_DB, { userId })
				: Promise.resolve([]),
		])
		this.server = createKodyMcpServer({
			instructions: buildMcpServerInstructions({
				userOverlay: overlay,
				domains: registry.capabilityDomains,
				popularPackages,
			}),
			jsonSchemaValidator: new CfWorkerJsonSchemaValidator(),
		})
		await registerTools(this.getRegistrationAgent())
	}
	/**
	 * Registration surface shared with the stateless lane (see
	 * `asMcpToolServer` for the SDK v1/v2 seam). `state`/`setState` are
	 * forwarded live so tool runners keep their per-session behavior
	 * (search preamble dedup, raw-fetch host nudges) on this lane.
	 */
	getRegistrationAgent() {
		const self = this
		const agent: McpRegistrationAgent & {
			state?: State
			setState?: (state: State) => void
		} = {
			server: asMcpToolServer(this.server),
			getEnv: () => self.getEnv(),
			getCallerContext: () => self.getCallerContext(),
			requireDomain: () => self.requireDomain(),
			getLoopbackExports: () => self.getLoopbackExports(),
			waitUntil: (promise) => self.waitUntil(promise),
			get state() {
				return self.state
			},
			setState: (state) => self.setState(state),
		}
		return agent
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
	waitUntil(promise: Promise<unknown>) {
		this.ctx.waitUntil(promise)
	}
	requireDomain() {
		const { baseUrl } = this.getCallerContext()
		invariant(
			baseUrl,
			'This should never happen, but somehow we did not get the baseUrl from the request handler',
		)
		return baseUrl
	}
	async purgeForAccountDeletion(input: { userId: string }) {
		await purgePersistedMcpAgentSession({
			storage: this.ctx.storage,
			doId: this.ctx.id.toString(),
			userId: input.userId,
		})
	}
}

export const MCP = Sentry.instrumentDurableObjectWithSentry(
	(env: Env) => buildSentryOptions(env),
	MCPBase,
)

/** Agent instance type for tool/resource registration (the Durable Object export is a wrapped class). */
export type MCP = InstanceType<typeof MCP>
