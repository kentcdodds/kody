import { z } from 'zod'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { type CapabilityContext } from '#mcp/capabilities/types.ts'
import { requireMcpUser } from '#mcp/capabilities/meta/require-user.ts'
import {
	journalEntryListOutputSchema,
	journalEntryRowToOutput,
	tagFilterSchema,
} from './shared.ts'
import { searchJournalEntriesSemantic } from './journal-vectorize.ts'

const inputSchema = z.object({
	query: z
		.string()
		.min(1)
		.max(500)
		.describe(
			'Case-insensitive search text matched against title, content, and tags.',
		),
	tag: tagFilterSchema.describe(
		'Optional tag filter applied in addition to the text query.',
	),
	limit: z
		.number()
		.int()
		.min(1)
		.max(50)
		.default(10)
		.describe('Maximum number of matching entries to return (1-50).'),
})

export const journalSearchEntriesCapability = defineDomainCapability(
	capabilityDomainNames.journaling,
	{
		name: 'journal_search_entries',
		description:
			'Search the signed-in user’s journal entries by title, content, and tags, optionally filtered to a specific tag.',
		keywords: [
			'journal',
			'search',
			'find',
			'entries',
			'notes',
			'reflection',
			'memory',
			'recall',
		],
		readOnly: true,
		idempotent: true,
		destructive: false,
		inputSchema,
		outputSchema: journalEntryListOutputSchema,
		async handler(args, ctx: CapabilityContext) {
			const user = requireMcpUser(ctx.callerContext)
			const { rows } = await searchJournalEntriesSemantic({
				env: ctx.env,
				db: ctx.env.APP_DB,
				userId: user.userId,
				filters: {
					query: args.query,
					limit: args.limit,
					tag: args.tag,
				},
			})
			return {
				entries: rows.map(journalEntryRowToOutput),
				count: rows.length,
			}
		},
	},
)
