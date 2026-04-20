import { z } from 'zod'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { requireMcpUser } from '#mcp/capabilities/meta/require-user.ts'
import {
	buildJobInspectionOutput,
	buildJobManagerDebugOutput,
	jobListOutputSchema,
} from './shared.ts'

export const jobListCapability = defineDomainCapability(
	capabilityDomainNames.jobs,
	{
		name: 'job_list',
		description:
			'List scheduled jobs for the signed-in user with status, counters, recent run history, and job-manager alarm state for debugging scheduling issues.',
		keywords: [
			'job',
			'list',
			'inspect',
			'debug',
			'scheduled jobs',
			'alarm',
			'status',
		],
		readOnly: true,
		idempotent: true,
		destructive: false,
		inputSchema: z.object({}),
		outputSchema: jobListOutputSchema,
		async handler(_args, ctx) {
			const user = requireMcpUser(ctx.callerContext)
			const { inspectJobsForUser } = await import('#worker/jobs/service.ts')
			const inspection = await inspectJobsForUser({
				env: ctx.env,
				userId: user.userId,
			})
			return {
				jobs: inspection.jobs.map((job) => buildJobInspectionOutput(job)),
				alarm: buildJobManagerDebugOutput(inspection.alarm),
			}
		},
	},
)
