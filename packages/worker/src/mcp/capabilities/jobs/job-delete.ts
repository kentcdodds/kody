import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { syncJobManagerAlarm } from '#worker/jobs/manager-do.ts'
import { deleteJob } from '#worker/jobs/service.ts'
import {
	jobDeleteOutputSchema,
	jobIdInputSchema,
	requireJobsUser,
} from './shared.ts'

export const jobDeleteCapability = defineDomainCapability(
	capabilityDomainNames.jobs,
	{
		name: 'job_delete',
		description: 'Delete a stored job.',
		keywords: ['job', 'delete', 'remove'],
		readOnly: false,
		idempotent: false,
		destructive: true,
		inputSchema: jobIdInputSchema,
		outputSchema: jobDeleteOutputSchema,
		async handler(args, ctx) {
			const user = requireJobsUser(ctx)
			let result: Awaited<ReturnType<typeof deleteJob>> | undefined
			let originalError: unknown
			try {
				result = await deleteJob({
					env: ctx.env,
					userId: user.userId,
					jobId: args.id,
				})
			} catch (error) {
				originalError = error
			}
			try {
				await syncJobManagerAlarm({
					env: ctx.env,
					userId: user.userId,
				})
			} catch (syncError) {
				console.error('[job_delete] failed to sync job manager alarm', {
					userId: user.userId,
					jobId: args.id,
					syncError,
				})
			}
			if (originalError) {
				throw originalError
			}
			return result!
		},
	},
)
