import { z } from 'zod'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { requireMcpUser } from '#mcp/capabilities/meta/require-user.ts'
import { McpCallerError } from '#mcp/caller-error.ts'
import { getRunRecord } from '#worker/run-records/service.ts'
import {
	formatRunRecord,
	formatRunRecordLog,
	runRecordLogSchema,
	runRecordSchema,
} from './shared.ts'

const inputSchema = z.object({
	run_id: z
		.string()
		.min(1)
		.describe(
			'Run id from run_list, job_get recent_runs, or another run reference.',
		),
})

const outputSchema = z.object({
	run: runRecordSchema,
	logs: z.array(runRecordLogSchema),
})

export const runGetCapability = defineDomainCapability(
	capabilityDomainNames.runs,
	{
		name: 'run_get',
		description:
			'Load one retained run with its captured log lines and error details so you can explain a failed job, crashed package app, broken webhook delivery, or other runtime failure. Records are retained about 30 days, capped per user, and pruned failure-last. Successful ad-hoc execute runs are not stored; only execute failures appear here.',
		keywords: [
			'run',
			'logs',
			'debug',
			'failure',
			'error',
			'crash',
			'trace',
			'stack',
			'why did it fail',
		],
		readOnly: true,
		idempotent: true,
		destructive: false,
		inputSchema,
		outputSchema,
		async handler(args, ctx) {
			const user = requireMcpUser(ctx.callerContext)
			const result = await getRunRecord({
				env: ctx.env,
				userId: user.userId,
				runId: args.run_id,
			})
			if (!result) {
				throw new McpCallerError(`Run "${args.run_id}" was not found.`)
			}
			return {
				run: formatRunRecord(result.run),
				logs: result.logs.map(formatRunRecordLog),
			}
		},
	},
)
