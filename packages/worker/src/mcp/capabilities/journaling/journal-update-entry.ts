import { z } from 'zod'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { type CapabilityContext } from '#mcp/capabilities/types.ts'
import {
	getJournalEntryById,
	updateJournalEntry,
} from './journal-entries-repo.ts'
import {
	journalEntryPatchSchema,
	journalEntryOutputSchema,
	journalEntryRowToOutput,
	normalizeJournalTags,
} from './shared.ts'
import { requireMcpUser } from '../meta/require-user.ts'

export const journalUpdateEntryCapability = defineDomainCapability(
	capabilityDomainNames.journaling,
	{
		name: 'journal_update_entry',
		description:
			'Update an existing journal entry owned by the signed-in user, including title, content, tags, and optional entry timestamp.',
		keywords: ['journal', 'update', 'edit', 'revise', 'entry', 'notes'],
		readOnly: false,
		idempotent: true,
		destructive: false,
		inputSchema: journalEntryPatchSchema,
		outputSchema: journalEntryOutputSchema,
		async handler(args, ctx: CapabilityContext) {
			const user = requireMcpUser(ctx.callerContext)
			const existing = await getJournalEntryById(
				ctx.env.APP_DB,
				user.userId,
				args.entry_id,
			)
			if (!existing) {
				throw new Error('Journal entry not found for this user.')
			}
			const tags =
				args.tags !== undefined
					? JSON.stringify(normalizeJournalTags(args.tags))
					: existing.tags
			const updated = await updateJournalEntry(
				ctx.env.APP_DB,
				user.userId,
				args.entry_id,
				{
					title: args.title ?? existing.title,
					content: args.content ?? existing.content,
					tags,
					entry_at:
						args.entry_at !== undefined ? args.entry_at : existing.entry_at,
				},
			)
			if (!updated) {
				throw new Error('Journal entry not found for this user.')
			}
			const row = await getJournalEntryById(
				ctx.env.APP_DB,
				user.userId,
				args.entry_id,
			)
			if (!row) {
				throw new Error('Journal entry could not be loaded after update.')
			}
			return journalEntryRowToOutput(row)
		},
	},
)
