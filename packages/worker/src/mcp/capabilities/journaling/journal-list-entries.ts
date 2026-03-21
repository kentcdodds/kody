import { z } from 'zod'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { type CapabilityContext } from '#mcp/capabilities/types.ts'
import { requireMcpUser } from '#mcp/capabilities/meta/require-user.ts'
import { listJournalEntriesByUserId } from './journal-entries-repo.ts'
import {
	journalEntryListOutputSchema,
	journalEntryRowToOutput,
	tagFilterSchema,
} from './shared.ts'

const inputSchema = z.object({
	limit: z
		.number()
		.int()
		.min(1)
		.max(100)
		.default(20)
		.describe(
			'Maximum number of recent entries to return (1-100, default 20).',
		),
	tag: tagFilterSchema.describe(
		'Optional tag filter. Matching is case-insensitive after normalization.',
	),
})

export const journalListEntriesCapability = defineDomainCapability(
	capabilityDomainNames.journaling,
	{
		name: 'journal_list_entries',
		description:
			'List the signed-in user’s most recent journal entries, optionally filtered by tag.',
		keywords: [
			'journal',
			'journaling',
			'list',
			'recent',
			'entries',
			'timeline',
			'tag',
		],
		readOnly: true,
		idempotent: true,
		destructive: false,
		inputSchema,
		outputSchema: journalEntryListOutputSchema,
		async handler(args, ctx: CapabilityContext) {
			const user = requireMcpUser(ctx.callerContext)
			const rows = await listJournalEntriesByUserId(
				ctx.env.APP_DB,
				user.userId,
				{
					limit: args.limit,
					tag: args.tag,
				},
			)
			return {
				entries: rows.map(journalEntryRowToOutput),
				count: rows.length,
			}
		},
	},
)
