import { z } from 'zod'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { type CapabilityContext } from '#mcp/capabilities/types.ts'
import { deleteJournalEntry } from './journal-entries-repo.ts'
import { requireMcpUser } from '../meta/require-user.ts'

const outputSchema = z.object({
	deleted: z.boolean(),
})

export const journalDeleteEntryCapability = defineDomainCapability(
	capabilityDomainNames.journaling,
	{
		name: 'journal_delete_entry',
		description: 'Delete a journal entry owned by the signed-in user.',
		keywords: ['journal', 'delete', 'remove', 'entry', 'note'],
		readOnly: false,
		idempotent: true,
		destructive: true,
		inputSchema: z.object({
			entry_id: z
				.string()
				.min(1)
				.describe('Journal entry id returned by journal_create_entry.'),
		}),
		outputSchema,
		async handler(args, ctx: CapabilityContext) {
			const user = requireMcpUser(ctx.callerContext)
			const deleted = await deleteJournalEntry(
				ctx.env.APP_DB,
				user.userId,
				args.entry_id,
			)
			return { deleted }
		},
	},
)
