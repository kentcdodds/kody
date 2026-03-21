import { z } from 'zod'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { type CapabilityContext } from '#mcp/capabilities/types.ts'
import { requireMcpUser } from '#mcp/capabilities/meta/require-user.ts'
import { insertJournalEntry } from './journal-entries-repo.ts'
import {
	journalEntryInputSchema,
	journalEntryOutputSchema,
	journalEntryRowToOutput,
	resolveCreateJournalEntryAt,
	normalizeJournalTags,
} from './shared.ts'

export const journalCreateEntryCapability = defineDomainCapability(
	capabilityDomainNames.journaling,
	{
		name: 'journal_create_entry',
		description:
			'Create a user-scoped journal entry with title, content, optional tags, and an optional event timestamp.',
		keywords: ['journal', 'journaling', 'entry', 'capture', 'note', 'reflect'],
		readOnly: false,
		idempotent: false,
		destructive: false,
		inputSchema: journalEntryInputSchema,
		outputSchema: journalEntryOutputSchema,
		async handler(args, ctx: CapabilityContext) {
			const user = requireMcpUser(ctx.callerContext)
			const entryId = crypto.randomUUID()
			const tags = normalizeJournalTags(args.tags)
			const now = new Date().toISOString()
			const row = {
				id: entryId,
				user_id: user.userId,
				title: args.title,
				content: args.content,
				tags: JSON.stringify(tags),
				entry_at: resolveCreateJournalEntryAt(args.entry_at, now),
				created_at: now,
				updated_at: now,
			}
			await insertJournalEntry(ctx.env.APP_DB, row)
			return journalEntryRowToOutput(row)
		},
	},
)
