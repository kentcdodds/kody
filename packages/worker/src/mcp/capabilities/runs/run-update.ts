import { z } from 'zod'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { requireMcpUser } from '#mcp/capabilities/meta/require-user.ts'
import { McpCallerError } from '#mcp/caller-error.ts'
import { updateRunErrorTriage } from '#worker/run-records/service.ts'
import {
	formatRunRecord,
	runErrorTriageUpdateSchema,
	runRecordSchema,
	runTriageNoteSchema,
} from './shared.ts'

const inputSchema = z.object({
	run_id: z
		.string()
		.min(1)
		.describe(
			'Run id from run_list, run_get, job_get recent_runs, or another run reference.',
		),
	triage: runErrorTriageUpdateSchema.describe(
		'Set soft triage on a retained error run: ignored (noise / soft-failure), resolved (already fixed), or open (clear triage and show it again in default listings). Does not delete the run or change error_name / error_message.',
	),
	note: runTriageNoteSchema,
})

const outputSchema = z.object({
	run: runRecordSchema,
})

export const runUpdateCapability = defineDomainCapability(
	capabilityDomainNames.runs,
	{
		name: 'run_update',
		description:
			'Mark a retained error run as ignored or resolved (or clear triage back to open) so Activity / run_list / run_summary can hide already-handled noise without deleting history. Only error runs accept ignored/resolved; original error details stay intact. Optional note records why. Default run_list and run_summary hide ignored/resolved errors — pass error_triage "all", "ignored", or "resolved" on run_list to inspect them.',
		keywords: [
			'run',
			'update',
			'triage',
			'ignore',
			'ignored',
			'resolve',
			'resolved',
			'reopen',
			'open',
			'dismiss',
			'noise',
			'activity',
			'failure',
			'error',
		],
		readOnly: false,
		idempotent: true,
		destructive: false,
		inputSchema,
		outputSchema,
		async handler(args, ctx) {
			const user = requireMcpUser(ctx.callerContext)
			const errorTriage = args.triage === 'open' ? null : args.triage
			const outcome = await updateRunErrorTriage({
				env: ctx.env,
				userId: user.userId,
				runId: args.run_id,
				errorTriage,
				triageNote: args.note,
			})
			if (!outcome.ok) {
				switch (outcome.reason) {
					case 'not_found':
					case 'unavailable':
						throw new McpCallerError(`Run "${args.run_id}" was not found.`)
					case 'not_error':
						throw new McpCallerError(
							`Run "${outcome.runId}" has status "${outcome.status}"; only error runs can be ignored or resolved.`,
						)
					default: {
						const exhaustive: never = outcome
						throw new McpCallerError(
							`Unexpected triage outcome: ${JSON.stringify(exhaustive)}`,
						)
					}
				}
			}
			return { run: formatRunRecord(outcome.run) }
		},
	},
)
