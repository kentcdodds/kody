import { z } from 'zod'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { type CapabilityContext } from '#mcp/capabilities/types.ts'
import { maxUserMcpServerInstructionsChars } from '#mcp/mcp-user-server-instruction-limits.ts'
import { getMcpUserServerInstructions } from '#mcp/user-server-instructions-repo.ts'
import { requireMcpUser } from './require-user.ts'

const outputSchema = z.object({
	instructions: z.string().nullable(),
	max_length: z.number().int().positive(),
})

export const metaGetMcpServerInstructionsCapability = defineDomainCapability(
	capabilityDomainNames.meta,
	{
		name: 'meta_get_mcp_server_instructions',
		description:
			'Read the signed-in user’s custom MCP server instructions overlay (if any). Empty means none. Same character limit as set.',
		keywords: [
			'instructions',
			'server',
			'overlay',
			'preferences',
			'mcp',
			'prompt',
		],
		readOnly: true,
		idempotent: true,
		destructive: false,
		inputSchema: z.object({}),
		outputSchema,
		async handler(_args, ctx: CapabilityContext) {
			const user = requireMcpUser(ctx.callerContext)
			const instructions = await getMcpUserServerInstructions(
				ctx.env.APP_DB,
				user.userId,
			)
			return {
				instructions,
				max_length: maxUserMcpServerInstructionsChars,
			}
		},
	},
)
