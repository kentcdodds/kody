import { z } from 'zod'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { requirePackageRealtimeContext } from './shared.ts'

const inputSchema = z.object({
	data: z.unknown(),
	topic: z.string().min(1).optional(),
	facet: z.string().min(1).optional(),
	package_id: z.string().min(1).optional(),
})

const outputSchema = z.object({
	delivered_count: z.number(),
	session_ids: z.array(z.string()),
})

export const sessionBroadcastCapability = defineDomainCapability(
	capabilityDomainNames.apps,
	{
		name: 'session_broadcast',
		description:
			'Broadcast a realtime websocket event to connected package app sessions, optionally scoped by facet or topic.',
		keywords: ['apps', 'websocket', 'realtime', 'session', 'broadcast'],
		readOnly: false,
		idempotent: false,
		destructive: false,
		inputSchema,
		outputSchema,
		async handler(args, ctx) {
			const realtime = await requirePackageRealtimeContext({
				env: ctx.env,
				callerContext: ctx.callerContext,
				explicitPackageId: args.package_id,
			})
			const result = await realtime.realtime.broadcast({
				data: args.data,
				topic: args.topic ?? null,
				facet: args.facet ?? null,
			})
			const normalizedResult =
				result && typeof result === 'object'
					? (result as {
							deliveredCount?: number
							sessionIds?: Array<unknown>
						})
					: null
			return {
				delivered_count:
					typeof normalizedResult?.deliveredCount === 'number'
						? normalizedResult.deliveredCount
						: 0,
				session_ids: Array.isArray(normalizedResult?.sessionIds)
					? normalizedResult.sessionIds.filter(
							(value): value is string =>
								typeof value === 'string' && value.trim().length > 0,
						)
					: [],
			}
		},
	},
)
