import { z } from 'zod'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { type CapabilityContext } from '#mcp/capabilities/types.ts'
import { requireMcpUser } from '#mcp/capabilities/meta/require-user.ts'
import { getJournalEntryById } from './journal-entries-repo.ts'
import { journalEntryOutputSchema, journalEntryRowToOutput } from './shared.ts'

export const journalGetEntryCapability = defineDomainCapability(
	capabilityDomainNames.journaling,
	{
		name: 'journal_get_entry',
		description: 'Load one saved journal entry owned by the signed-in user.',
		keywords: ['journal', 'entry', 'get', 'read', 'load'],
		readOnly: true,
		idempotent: true,
		destructive: false,
		inputSchema: z.object({
			entry_id: z
				.string()
				.min(1)
				.describe('Journal entry id returned by journal_create_entry.'),
		}),
		outputSchema: journalEntryOutputSchema,
		async handler(args, ctx: CapabilityContext) {
			const user = requireMcpUser(ctx.callerContext)
			const row = await getJournalEntryById(
				ctx.env.APP_DB,
				user.userId,
				args.entry_id,
			)
			if (!row) {
				throw new Error('Journal entry not found for this user.')
			}
			return journalEntryRowToOutput(row)
		},
	},
)
