import { z } from 'zod'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { requireMcpRequest } from '#mcp/capabilities/meta/require-user.ts'
import { disableEnablementForCaller } from '#worker/enablements/service.ts'
import { enablementSchema, toEnablementOutput } from './enablement-shared.ts'

export const enablementDisableCapability = defineDomainCapability(
	capabilityDomainNames.packages,
	{
		name: 'enablementDisable',
		orgPermission: 'org:read',
		description:
			'Turn one enablement off for good; it stops on the next event. Its enabler or an org Owner may turn it off. Turning it on again creates a new enablement with enablementEnable.',
		keywords: ['disable', 'enablement', 'turn off', 'stop', 'trigger'],
		readOnly: false,
		idempotent: true,
		destructive: true,
		inputSchema: z.object({
			enablementId: z.string().min(1).describe('Enablement id.'),
		}),
		outputSchema: z.object({ enablement: enablementSchema }),
		async handler(args, ctx) {
			const enablement = await disableEnablementForCaller({
				env: ctx.env,
				request: requireMcpRequest(ctx.callerContext),
				enablementId: args.enablementId,
			})
			return { enablement: toEnablementOutput(enablement) }
		},
	},
)
