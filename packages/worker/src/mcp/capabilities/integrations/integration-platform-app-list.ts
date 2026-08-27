import { z } from 'zod'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import {
	emptyCapabilityInputSchema,
	type CapabilityContext,
} from '#mcp/capabilities/types.ts'
import { listAvailablePlatformApps } from '#worker/integrations/service.ts'
import {
	platformOauthAppPublicSchema,
	toPlatformOauthAppPublic,
} from './platform-app-shared.ts'

const outputSchema = z.object({
	apps: z.array(platformOauthAppPublicSchema),
})

export const integrationPlatformAppListCapability = defineDomainCapability(
	capabilityDomainNames.integrations,
	{
		name: 'integration_platform_app_list',
		description:
			'List operator-provisioned platform OAuth apps on this deployment. User connections use a bring-your-own provider app at /connect/oauth; this list is inspection only and is not a connect path.',
		keywords: [
			'integration',
			'oauth',
			'platform',
			'built-in',
			'connect',
			'provider',
			'managed',
		],
		readOnly: true,
		idempotent: true,
		destructive: false,
		inputSchema: emptyCapabilityInputSchema,
		outputSchema,
		async handler(_args, ctx: CapabilityContext) {
			const apps = await listAvailablePlatformApps({ env: ctx.env })
			return {
				apps: apps.map(toPlatformOauthAppPublic),
			}
		},
	},
)
