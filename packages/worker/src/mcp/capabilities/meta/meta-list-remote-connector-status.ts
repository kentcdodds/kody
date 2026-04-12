import { z } from 'zod'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { getRemoteConnectorStatus } from '#worker/home/status.ts'
import { normalizeRemoteConnectorRefs } from '@kody-internal/shared/remote-connectors.ts'

const connectorStatusSchema = z.object({
	connector_kind: z.string(),
	connector_instance_id: z.string(),
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
			'Report connection status for each remote connector attached to this session (kind + instance id). Use when search results miss remote capabilities or a remote capability fails.',
		keywords: [
			'remote',
			'connector',
			'status',
			'connected',
			'disconnected',
			'home',
			'troubleshoot',
		],
		readOnly: true,
		idempotent: true,
		destructive: false,
		inputSchema: z.object({}),
		outputSchema,
		async handler(_args, ctx) {
			const refs = normalizeRemoteConnectorRefs(ctx.callerContext)
			const connectors = await Promise.all(
				refs.map(async (ref) => {
					const s = await getRemoteConnectorStatus(ctx.env, ref)
					return {
						connector_kind: s.connectorKind,
						connector_instance_id: s.connectorId ?? ref.instanceId,
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
