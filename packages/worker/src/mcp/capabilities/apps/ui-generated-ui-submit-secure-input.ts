import { z } from 'zod'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { type CapabilityContext } from '#mcp/capabilities/types.ts'
import { storeDraftSecrets } from '#mcp/connections/connection-service.ts'
import { verifyGeneratedUiAppSession } from '#mcp/generated-ui-app-session.ts'

const inputSchema = z.object({
	token: z.string().min(1),
	setup_id: z.string().min(1),
	fields: z.record(z.string(), z.string().min(1)),
})

export const uiGeneratedUiSubmitSecureInputCapability = defineDomainCapability(
	capabilityDomainNames.apps,
	{
		name: 'generated_ui_submit_secure_input',
		description:
			'Submit secure input for generated UI sessions via the host bridge without exposing tokens to the UI frame.',
		keywords: ['generated ui', 'secure input', 'session', 'app', 'host'],
		readOnly: false,
		idempotent: false,
		destructive: false,
		inputSchema,
		async handler(args, ctx: CapabilityContext) {
			const session = await verifyGeneratedUiAppSession(ctx.env, args.token)
			const result = await storeDraftSecrets({
				env: ctx.env,
				userId: session.user.userId,
				draftId: args.setup_id,
				fields: args.fields,
			})
			return {
				ok: true,
				...result,
			}
		},
	},
)
