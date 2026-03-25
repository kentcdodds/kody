import { z } from 'zod'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { getHomeConnectorStatus } from '#worker/home/status.ts'

const outputSchema = z.object({
	status: z.enum(['connected', 'disconnected', 'unavailable', 'error']),
	connected: z.boolean(),
	connector_id: z.string().nullable(),
	connected_at: z.string().nullable(),
	last_seen_at: z.string().nullable(),
	tool_count: z.number().int().nonnegative(),
	message: z.string(),
	error: z.string().nullable(),
})

export const metaGetHomeConnectorStatusCapability = defineDomainCapability(
	capabilityDomainNames.meta,
	{
		name: 'meta_get_home_connector_status',
		description:
			'Report whether the home connector is connected, when it was last seen, and whether home capabilities are currently usable. Use this when home search results are missing or a home capability fails.',
		keywords: [
			'home',
			'connector',
			'status',
			'connected',
			'disconnected',
			'unavailable',
			'troubleshoot',
			'roku',
		],
		readOnly: true,
		idempotent: true,
		destructive: false,
		inputSchema: z.object({}),
		outputSchema,
		async handler(_args, ctx) {
			const status = await getHomeConnectorStatus(
				ctx.env,
				ctx.callerContext.homeConnectorId ?? null,
			)
			return {
				status: status.state,
				connected: status.connected,
				connector_id: status.connectorId,
				connected_at: status.connectedAt,
				last_seen_at: status.lastSeenAt,
				tool_count: status.toolCount,
				message: status.message,
				error: status.error,
			}
		},
	},
)
