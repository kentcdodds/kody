/**
 * Stateless `/mcp` lane for protocol revision 2026-07-28.
 *
 * 2025-era ("legacy") traffic keeps its sessionful Durable Object `McpAgent`
 * lane unchanged; requests carrying the 2026-07-28 per-request `_meta`
 * envelope are served here by a per-request SDK v2 server with no session,
 * no Durable Object, and no cross-request state. Routing between the lanes
 * happens in `handleMcpRequest` via the SDK's own `isLegacyRequest`
 * predicate, and this handler keeps `legacy: 'reject'` so the two lanes can
 * never both answer the same era.
 *
 * Tool definitions are shared with the legacy lane through `registerTools`,
 * so the lanes cannot drift apart. Lane usage is recorded to Analytics
 * Engine (see `protocol-metrics.ts`); the legacy lane is retired once its
 * traffic stops.
 */

import { type exports as workerExports } from 'cloudflare:workers'
import { invariant } from '@epic-web/invariant'
import { McpServer, createMcpHandler } from '@modelcontextprotocol/server'
import { CfWorkerJsonSchemaValidator } from '@modelcontextprotocol/server/validators/cf-worker'
import { type McpCallerContext } from '@kody-internal/shared/chat.ts'
import { buildMcpServerInstructions } from './server-instructions.ts'
import { registerTools } from './register-tools.ts'
import {
	asMcpToolServer,
	type McpRegistrationAgent,
} from './mcp-registration-agent.ts'
import { getMcpUserServerInstructions } from './user-server-instructions-repo.ts'
import { getCapabilityRegistryForContext } from './capabilities/registry.ts'
import { listPopularAgentPackagesForUser } from '#worker/usage/agent-package-conversation-uses.ts'

const kodyMcpServerInfo = {
	name: 'kody-mcp',
	version: '1.0.0',
} as const

/**
 * Serve one modern-era `/mcp` request. Called after `handleMcpRequest` has
 * authenticated the bearer token and built the caller context; this handler
 * performs no token verification of its own.
 */
export async function handleStatelessMcpRequest(input: {
	request: Request
	env: Env
	ctx: ExecutionContext
	callerContext: McpCallerContext
	/** Body already parsed by lane classification, so it is read only once. */
	parsedBody?: unknown
}): Promise<Response> {
	const { request, env, ctx, callerContext } = input
	const handler = createMcpHandler(
		async () => {
			// `server/discover` is the only modern method that returns server
			// metadata, so instruction assembly (three D1 reads) stays off the
			// tools/call hot path. Modern Streamable HTTP requires the
			// Mcp-Method header, and the SDK rejects header/body mismatches.
			const instructions =
				request.headers.get('Mcp-Method') === 'server/discover'
					? await buildStatelessServerInstructions({ env, callerContext })
					: undefined
			const server = new McpServer(kodyMcpServerInfo, {
				...(instructions ? { instructions } : {}),
				jsonSchemaValidator: new CfWorkerJsonSchemaValidator(),
			})
			await registerTools(
				createStatelessRegistrationAgent({ server, env, ctx, callerContext }),
			)
			return server
		},
		{
			// The Durable Object McpAgent lane owns 2025-era traffic (sessions,
			// SSE streams, resumability); rejecting legacy here keeps exactly
			// one lane authoritative per era.
			legacy: 'reject',
			onerror: (error) => console.warn('mcp-stateless-lane-error', error),
		},
	)
	return handler.fetch(
		request,
		input.parsedBody === undefined
			? undefined
			: { parsedBody: input.parsedBody },
	)
}

async function buildStatelessServerInstructions(input: {
	env: Env
	callerContext: McpCallerContext
}) {
	const userId = input.callerContext.user?.userId ?? null
	const [overlay, registry, popularPackages] = await Promise.all([
		userId !== null
			? getMcpUserServerInstructions(input.env.APP_DB, userId)
			: Promise.resolve(null),
		getCapabilityRegistryForContext({
			env: input.env,
			callerContext: input.callerContext,
		}),
		userId !== null
			? listPopularAgentPackagesForUser(input.env.APP_DB, { userId })
			: Promise.resolve([]),
	])
	return buildMcpServerInstructions({
		userOverlay: overlay,
		domains: registry.capabilityDomains,
		popularPackages,
	})
}

/**
 * Per-request registration agent for the stateless lane. Unlike the Durable
 * Object lane there is no agent state, so stateful niceties (search preamble
 * dedup, raw-fetch host nudge accumulation) degrade to per-call behavior —
 * the tool runners already handle a stateless agent defensively.
 */
function createStatelessRegistrationAgent(input: {
	server: McpServer
	env: Env
	ctx: ExecutionContext
	callerContext: McpCallerContext
}): McpRegistrationAgent {
	return {
		server: asMcpToolServer(input.server),
		getEnv: () => input.env,
		getCallerContext: () => input.callerContext,
		requireDomain: () => {
			const { baseUrl } = input.callerContext
			invariant(
				baseUrl,
				'This should never happen, but somehow we did not get the baseUrl from the request handler',
			)
			return baseUrl
		},
		getLoopbackExports: () => input.ctx.exports as typeof workerExports,
		waitUntil: (promise) => input.ctx.waitUntil(promise),
	}
}
