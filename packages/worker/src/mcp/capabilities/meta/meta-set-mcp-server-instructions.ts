import { z } from 'zod'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { type CapabilityContext } from '#mcp/capabilities/types.ts'
import { maxUserMcpServerInstructionsChars } from '#mcp/mcp-user-server-instruction-limits.ts'
import {
	getMcpUserServerInstructions,
	saveMcpUserServerInstructions,
} from '#mcp/user-server-instructions-repo.ts'
import { requireMcpUser } from './require-user.ts'

const outputSchema = z.object({
	ok: z.literal(true),
	max_length: z.number().int().positive(),
	/** Effective stored text after trim (null if cleared). */
	instructions: z.string().nullable(),
})

export const metaSetMcpServerInstructionsCapability = defineDomainCapability(
	capabilityDomainNames.meta,
	{
		name: 'meta_set_mcp_server_instructions',
		description:
			'Replace or clear the signed-in user’s custom MCP server instructions overlay (appended to built-in server instructions for new MCP connections). Pass an empty string to clear. Changes apply to new MCP sessions—reconnect the client if the host caches server instructions.',
		keywords: [
			'instructions',
			'server',
			'overlay',
			'preferences',
			'mcp',
			'prompt',
		],
		readOnly: false,
		idempotent: true,
		destructive: false,
		inputSchema: z.object({
			instructions: z
				.string()
				.max(
					maxUserMcpServerInstructionsChars,
					`instructions must be at most ${maxUserMcpServerInstructionsChars} characters`,
				)
				.describe(
					'Full replacement text for the user overlay, or empty string to remove it.',
				),
		}),
		outputSchema,
		async handler(args, ctx: CapabilityContext) {
			const user = requireMcpUser(ctx.callerContext)
			await saveMcpUserServerInstructions(
				ctx.env.APP_DB,
				user.userId,
				args.instructions,
			)
			const stored = await getMcpUserServerInstructions(
				ctx.env.APP_DB,
				user.userId,
			)
			return {
				ok: true as const,
				max_length: maxUserMcpServerInstructionsChars,
				instructions: stored,
			}
		},
	},
)
