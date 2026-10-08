import {
	CLIENT_CAPABILITIES_META_KEY,
	type McpServer,
	type ServerCapabilities,
} from '@modelcontextprotocol/server'
import { z } from 'zod'
import { type McpCallerContext } from '@kody-internal/shared/chat.ts'
import { mcpEventsExtensionFlagKey } from '#universal/feature-flags/registry.ts'
import { resolveCallerFeatureFlags } from '#mcp/capabilities/access-control.ts'
import {
	mcpEventsExtensionId,
	mcpEventsListMethod,
	mcpEventsSubscribeMethod,
	mcpEventsUnsubscribeMethod,
} from './constants.ts'
import { listMcpEventSources, mcpEventInputSchema } from './list-events.ts'
import {
	mcpEventsSubscribeParamsSchema,
	mcpEventsSubscribeResultSchema,
	subscribeMcpEvent,
	type McpEventsPrincipal,
} from './subscribe.ts'
import {
	mcpEventsUnsubscribeParamsSchema,
	mcpEventsUnsubscribeResultSchema,
	unsubscribeMcpEvent,
} from './unsubscribe.ts'

const mcpEventsListParamsSchema = z
	.looseObject({ cursor: z.string().nullable().optional() })
	.optional()

const mcpEventsListResultSchema = z.object({
	events: z.array(
		z.object({
			name: z.string(),
			description: z.string(),
			delivery: z.array(z.literal('webhook')),
			inputSchema: z.record(z.string(), z.unknown()),
			payloadSchema: z.record(z.string(), z.unknown()),
		}),
	),
})

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

/**
 * Client capabilities for one modern (2026-07-28) request ride in the
 * per-request envelope: `params._meta["io.modelcontextprotocol/clientCapabilities"]`.
 * Every modern request carries it, including `server/discover`.
 */
export function readMcpRequestClientCapabilities(
	parsedBody: unknown,
): Record<string, unknown> | null {
	const message = Array.isArray(parsedBody)
		? parsedBody.find(isRecord)
		: parsedBody
	if (!isRecord(message)) return null
	const params = message['params']
	if (!isRecord(params)) return null
	const meta = params['_meta']
	if (!isRecord(meta)) return null
	const capabilities = meta[CLIENT_CAPABILITIES_META_KEY]
	return isRecord(capabilities) ? capabilities : null
}

/**
 * The draft has no settled client-side declaration yet, so accept each shape
 * in circulation: top-level `events`, `experimental.events`, or the
 * extension id under `extensions`.
 */
export function clientSupportsMcpEvents(
	capabilities: Record<string, unknown> | null,
): boolean {
	if (!capabilities) return false
	if (isRecord(capabilities['events'])) return true
	const experimental = capabilities['experimental']
	if (isRecord(experimental) && isRecord(experimental['events'])) return true
	const extensions = capabilities['extensions']
	return isRecord(extensions) && isRecord(extensions[mcpEventsExtensionId])
}

/**
 * Progressive enhancement on the stateless lane: advertise `events` and
 * serve `events/list|subscribe|unsubscribe` only when the request's client
 * declares events support, the caller is an OAuth principal, and the
 * `mcp-events-extension` flag is on for the user. Otherwise nothing is
 * registered and the methods answer MethodNotFound.
 *
 * SDK workaround: `ServerCapabilitiesSchema` has no `events` key, so the
 * typed capability object cannot name it; the SDK spreads capabilities into
 * the `server/discover` result at runtime, so the cast is load-bearing only
 * for types. Custom methods use the 3-arg `setRequestHandler` form.
 */
export async function registerMcpEvents(input: {
	server: McpServer
	env: Env
	callerContext: McpCallerContext
	oauthClientId: string | null
	clientCapabilities: Record<string, unknown> | null
}): Promise<boolean> {
	if (!clientSupportsMcpEvents(input.clientCapabilities)) return false
	if (!input.callerContext.user?.userId || !input.oauthClientId) return false
	const flags = await resolveCallerFeatureFlags(input.env, input.callerContext)
	if (flags[mcpEventsExtensionFlagKey] !== true) return false

	const principal: McpEventsPrincipal = {
		env: input.env,
		callerContext: input.callerContext,
		oauthClientId: input.oauthClientId,
	}
	const eventsCapability: Record<string, unknown> = { events: {} }
	input.server.server.registerCapabilities(
		eventsCapability as ServerCapabilities,
	)
	input.server.server.setRequestHandler(
		mcpEventsListMethod,
		{ params: mcpEventsListParamsSchema, result: mcpEventsListResultSchema },
		async () => {
			const sources = await listMcpEventSources({
				env: input.env,
				callerContext: input.callerContext,
			})
			return {
				events: [...sources.values()].map(({ definition }) => ({
					...definition,
					inputSchema: { ...mcpEventInputSchema },
				})),
			}
		},
	)
	input.server.server.setRequestHandler(
		mcpEventsSubscribeMethod,
		{
			params: mcpEventsSubscribeParamsSchema,
			result: mcpEventsSubscribeResultSchema,
		},
		async (params) => await subscribeMcpEvent(principal, params),
	)
	input.server.server.setRequestHandler(
		mcpEventsUnsubscribeMethod,
		{
			params: mcpEventsUnsubscribeParamsSchema,
			result: mcpEventsUnsubscribeResultSchema,
		},
		async (params) => await unsubscribeMcpEvent(principal, params),
	)
	return true
}
