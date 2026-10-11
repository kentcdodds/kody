import {
	listScopeIncludes,
	loadResourceListScope,
} from '#worker/authorization/authorize.ts'
import { ownerIdFromCaller } from '#worker/request-context/owner-id.ts'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import {
	requireMcpRequest,
	requireMcpUser,
} from '#mcp/capabilities/meta/require-user.ts'
import { emptyCapabilityInputSchema } from '#mcp/capabilities/types.ts'
import { inspectJobsForUser } from '#worker/jobs/inspect.ts'
import {
	buildJobInspectionOutput,
	buildJobManagerDebugOutput,
	jobListOutputSchema,
} from './shared.ts'

export const jobListCapability = defineDomainCapability(
	capabilityDomainNames.jobs,
	{
		name: 'jobList',
		orgPermission: 'job:read',
		description:
			"List existing scheduled jobs for the signed-in user with status, counters, and job-manager alarm state for debugging scheduling issues. Recurring schedules belong on a package (`kody.jobs`); deferred one-shots use `workflows.create`. recent_runs is empty here for efficiency; use jobGet for one job's recent runs or runList/runSummary for cross-job failure history.",
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
		inputSchema: emptyCapabilityInputSchema,
		outputSchema: jobListOutputSchema,
		async handler(_args, ctx) {
			requireMcpUser(ctx.callerContext)
			const request = requireMcpRequest(ctx.callerContext)
			const [inspection, scope] = await Promise.all([
				inspectJobsForUser({
					env: ctx.env,
					userId: ownerIdFromCaller(ctx.callerContext),
				}),
				loadResourceListScope({ env: ctx.env, request }, 'job:read', 'job'),
			])
			return {
				jobs: inspection.jobs
					.filter((job) => listScopeIncludes(scope, job.id))
					.map((job) => buildJobInspectionOutput(job, { recentRuns: [] })),
				alarm: buildJobManagerDebugOutput(inspection.alarm, scope),
			}
		},
	},
)
