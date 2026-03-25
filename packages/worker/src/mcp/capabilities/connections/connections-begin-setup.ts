import { z } from 'zod'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { type CapabilityContext } from '#mcp/capabilities/types.ts'
import { connectionAuthSpecSchema } from '#mcp/connections/auth-spec.ts'
import { beginConnectionSetup } from '#mcp/connections/connection-service.ts'
import { requireMcpUser } from '#mcp/capabilities/meta/require-user.ts'

const outputSchema = z.object({
	setup_id: z.string(),
	provider: z.object({
		key: z.string(),
		display_name: z.string(),
	}),
	label: z.string().nullable(),
	auth_strategy: z.string(),
	status: z.string(),
	secret_fields: z.array(
		z.object({
			name: z.string(),
			label: z.string(),
			description: z.string().optional(),
			input_type: z.enum(['text', 'password']),
		}),
	),
	instructions: z.array(z.string()),
	expires_at: z.string(),
})

export const connectionsBeginSetupCapability = defineDomainCapability(
	capabilityDomainNames.connections,
	{
		name: 'connections_begin_setup',
		description:
			'Begin a user-owned provider connection draft. Use this when a skill can do something useful after initiating setup, such as returning a setup id that a generated UI can continue with secure secret collection or OAuth.',
		keywords: [
			'connection',
			'provider',
			'oauth',
			'api key',
			'manual token',
			'secure input',
			'setup',
		],
		readOnly: false,
		idempotent: false,
		destructive: false,
		inputSchema: z.object({
			provider: z.object({
				key: z.string().min(1),
				display_name: z.string().min(1),
			}),
			auth: connectionAuthSpecSchema,
			label: z
				.string()
				.min(1)
				.optional()
				.describe('Optional preferred label for the resulting connection.'),
		}),
		outputSchema,
		async handler(args, ctx: CapabilityContext) {
			const user = requireMcpUser(ctx.callerContext)
			return beginConnectionSetup({
				env: ctx.env,
				userId: user.userId,
				provider: args.provider,
				auth: args.auth,
				label: args.label,
			})
		},
	},
)
