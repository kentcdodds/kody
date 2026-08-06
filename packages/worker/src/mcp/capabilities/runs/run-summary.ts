import { z } from 'zod'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { requireMcpUser } from '#mcp/capabilities/meta/require-user.ts'
import { summarizeRunRecords } from '#worker/run-records/service.ts'
import { formatRunRecordSummary, runRecordSummarySchema } from './shared.ts'

const inputSchema = z.object({
	since: z
		.string()
		.min(1)
		.optional()
		.describe(
			'Optional ISO 8601 lower bound (inclusive). Defaults to the earliest retained record when omitted.',
		),
})

export const runSummaryCapability = defineDomainCapability(
	capabilityDomainNames.runs,
	{
		name: 'run_summary',
		description:
			'Summarize recent run totals, open error count (excluding ignored/resolved), ignored/resolved counts, still-running count, and per-surface breakdown to answer "is anything broken?" before drilling into run_list or run_get. Use run_update to mark handled error noise. Successful ad-hoc execute runs are not recorded (only execute failures count); other surfaces include both. Records are retained about 30 days, capped per user, and pruned failure-last.',
		keywords: [
			'summary',
			'health',
			'broken',
			'errors',
			'failures',
			'status',
			'overview',
			'debug',
			'observability',
			'ignored',
			'resolved',
			'triage',
		],
		readOnly: true,
		idempotent: true,
		destructive: false,
		inputSchema,
		outputSchema: runRecordSummarySchema,
		async handler(args, ctx) {
			const user = requireMcpUser(ctx.callerContext)
			const summary = await summarizeRunRecords({
				env: ctx.env,
				userId: user.userId,
				since: args.since ?? null,
			})
			return formatRunRecordSummary(summary)
		},
	},
)
