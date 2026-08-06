import { z } from 'zod'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { requireMcpUser } from '#mcp/capabilities/meta/require-user.ts'
import { listRunRecords } from '#worker/run-records/service.ts'
import {
	formatRunRecord,
	runErrorTriageFilterSchema,
	runListLimitSchema,
	runRecordSchema,
	runStatusSchema,
	runSurfaceSchema,
} from './shared.ts'

const inputSchema = z.object({
	surface: runSurfaceSchema
		.optional()
		.describe(
			'Optional runtime surface filter such as job, webhook, execute, app_fetch, or workflow.',
		),
	status: runStatusSchema
		.optional()
		.describe('Optional status filter: running, success, or error.'),
	package_id: z
		.string()
		.min(1)
		.optional()
		.describe('Optional saved package id to scope package-owned runs.'),
	job_id: z
		.string()
		.min(1)
		.optional()
		.describe('Optional job id to list runs for one scheduled job.'),
	since: z
		.string()
		.min(1)
		.optional()
		.describe(
			'Optional ISO 8601 lower bound on started_at (inclusive), for example 2026-07-01T00:00:00.000Z.',
		),
	error_triage: runErrorTriageFilterSchema
		.optional()
		.describe(
			'Soft error-triage filter. Defaults to open (hides ignored/resolved noise). Use ignored, resolved, or all to inspect triaged runs.',
		),
	limit: runListLimitSchema,
	cursor: z
		.string()
		.min(1)
		.optional()
		.describe('Opaque pagination cursor from a previous next_cursor value.'),
})

const outputSchema = z.object({
	runs: z.array(runRecordSchema),
	next_cursor: z
		.string()
		.nullable()
		.describe(
			'Opaque cursor for the next page, or null when this is the last page.',
		),
})

export const runListCapability = defineDomainCapability(
	capabilityDomainNames.runs,
	{
		name: 'run_list',
		description:
			'List recent execution history across jobs, webhooks, package apps, services, workflows, and other runtimes so you can debug failures, crashes, and "why did my job stop working" questions. Key-less successful ad-hoc execute runs are intentionally not recorded (only execute failures are, plus execute calls that supplied an idempotencyKey); every other surface records both success and error. Terminal rows may include a bounded metadata.result snapshot. By default, ignored/resolved error runs are hidden (error_triage defaults to open); use run_update to triage noise, or pass error_triage all/ignored/resolved to inspect those rows. Records are retained about 30 days, capped per user, and pruned failure-last (successes drop before errors).',
		keywords: [
			'run',
			'runs',
			'history',
			'logs',
			'debug',
			'failure',
			'failures',
			'error',
			'errors',
			'crash',
			'job failed',
			'scheduled job',
			'package app',
			'observability',
			'trace',
			'ignored',
			'resolved',
			'triage',
		],
		readOnly: true,
		idempotent: true,
		destructive: false,
		inputSchema,
		outputSchema,
		async handler(args, ctx) {
			const user = requireMcpUser(ctx.callerContext)
			const page = await listRunRecords({
				env: ctx.env,
				userId: user.userId,
				filter: {
					surface: args.surface ?? null,
					status: args.status ?? null,
					packageId: args.package_id ?? null,
					jobId: args.job_id ?? null,
					since: args.since ?? null,
					errorTriage: args.error_triage ?? 'open',
				},
				limit: args.limit ?? null,
				cursor: args.cursor ?? null,
			})
			return {
				runs: page.runs.map(formatRunRecord),
				next_cursor: page.nextCursor,
			}
		},
	},
)
