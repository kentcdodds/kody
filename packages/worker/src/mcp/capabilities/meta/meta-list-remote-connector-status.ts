import { z } from 'zod'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { emptyCapabilityInputSchema } from '#mcp/capabilities/types.ts'
import { getRemoteConnectorStatus } from '#worker/remote-connector/status.ts'
import { normalizeRemoteConnectorRefs } from '@kody-internal/shared/remote-connectors.ts'

const connectorStatusSchema = z.object({
	connector_id: z.string(),
	status: z.enum(['connected', 'disconnected', 'unavailable', 'error']),
	connected: z.boolean(),
	connected_at: z.string().nullable(),
	last_seen_at: z.string().nullable(),
	tool_count: z.number().int().nonnegative(),
	message: z.string(),
	error: z.string().nullable(),
})

const outputSchema = z.object({
	connectors: z.array(connectorStatusSchema),
})

export const metaListRemoteConnectorStatusCapability = defineDomainCapability(
	capabilityDomainNames.meta,
	{
		name: 'meta_list_remote_connector_status',
		description:
			'Report connection status for each remote connector attached to this session. Use when search results miss remote capabilities or a remote capability fails.',
		keywords: [
			'remote',
			'connector',
			'status',
			'connected',
			'disconnected',
			'troubleshoot',
		],
		readOnly: true,
		idempotent: true,
		destructive: false,
		inputSchema: emptyCapabilityInputSchema,
		outputSchema,
		async handler(_args, ctx) {
			const refs = normalizeRemoteConnectorRefs(ctx.callerContext)
			const userId = ctx.callerContext.user?.userId
			if (!userId) {
				return { connectors: [] }
			}
			const connectors = await Promise.all(
				refs.map(async (ref) => {
					const s = await getRemoteConnectorStatus({
						env: ctx.env,
						userId,
						ref,
					})
					return {
						connector_id: s.connectorId ?? ref.instanceId,
						status: s.state,
						connected: s.connected,
						connected_at: s.connectedAt,
						last_seen_at: s.lastSeenAt,
						tool_count: s.toolCount,
						message: s.message,
						error: s.error,
					}
				}),
			)
			return { connectors }
		},
	},
)
