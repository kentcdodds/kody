import { z } from 'zod'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { emptyCapabilityInputSchema } from '#mcp/capabilities/types.ts'
import { platformOauthAppPublicSchema } from './platform-app-shared.ts'

const outputSchema = z.object({
	apps: z.array(platformOauthAppPublicSchema),
})

export const integrationPlatformAppListCapability = defineDomainCapability(
	capabilityDomainNames.integrations,
	{
		name: 'integration_platform_app_list',
		description:
			'Platform (built-in) OAuth apps are being retired. This list is always empty. Connect with a bring-your-own provider app at /connect/oauth. Operators inspect remaining apps with admin_platform_oauth_app_list.',
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
		async handler() {
			return { apps: [] }
		},
	},
)
