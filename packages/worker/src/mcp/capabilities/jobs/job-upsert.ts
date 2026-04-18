import { type CapabilityContext } from '#mcp/capabilities/types.ts'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { createJob, updateJob } from '#worker/jobs/service.ts'
import { syncJobManagerAlarm } from '#worker/jobs/manager-do.ts'
import {
	jobUpsertInputSchema,
	jobViewSchema,
	requireJobsUser,
} from './shared.ts'

export const jobUpsertCapability = defineDomainCapability(
	capabilityDomainNames.jobs,
	{
		name: 'job_upsert',
		description:
			'Create a new job when id is omitted, or update an existing job when id is provided. Jobs have durable storage identified by `storageId` and support cron schedules, interval schedules, and one-shot runs.',
		keywords: ['job', 'upsert', 'create', 'update', 'cron', 'interval'],
		readOnly: false,
		idempotent: false,
		destructive: false,
		inputSchema: jobUpsertInputSchema,
		outputSchema: jobViewSchema,
		async handler(args, ctx: CapabilityContext) {
			const user = requireJobsUser(ctx)
			const result =
				args.id === undefined
					? await createJob({
							env: ctx.env,
							callerContext: ctx.callerContext,
							body: {
								name: args.name ?? '',
								code: args.code === undefined ? '' : args.code,
								...(args.sourceId !== undefined
									? { sourceId: args.sourceId }
									: {}),
								...(args.publishedCommit !== undefined
									? { publishedCommit: args.publishedCommit }
									: {}),
								...(args.repoCheckPolicy !== undefined
									? { repoCheckPolicy: args.repoCheckPolicy }
									: {}),
								...(args.params !== undefined && args.params !== null
									? { params: args.params }
									: {}),
								schedule: args.schedule!,
								...(args.timezone !== undefined
									? { timezone: args.timezone }
									: {}),
								...(args.enabled !== undefined
									? { enabled: args.enabled }
									: {}),
								...(args.killSwitchEnabled !== undefined
									? { killSwitchEnabled: args.killSwitchEnabled }
									: {}),
							},
						})
					: await updateJob({
							env: ctx.env,
							callerContext: ctx.callerContext,
							body: {
								id: args.id,
								...(args.name !== undefined ? { name: args.name } : {}),
								...(typeof args.code === 'string' ? { code: args.code } : {}),
								...(args.code === null ? { code: null } : {}),
								...(args.sourceId !== undefined
									? { sourceId: args.sourceId }
									: {}),
								...(args.publishedCommit !== undefined
									? { publishedCommit: args.publishedCommit }
									: {}),
								...(args.repoCheckPolicy !== undefined
									? { repoCheckPolicy: args.repoCheckPolicy }
									: {}),
								...(args.params !== undefined ? { params: args.params } : {}),
								...(args.schedule !== undefined
									? { schedule: args.schedule }
									: {}),
								...(args.timezone !== undefined
									? { timezone: args.timezone }
									: {}),
								...(args.enabled !== undefined
									? { enabled: args.enabled }
									: {}),
								...(args.killSwitchEnabled !== undefined
									? { killSwitchEnabled: args.killSwitchEnabled }
									: {}),
							},
						})
			try {
				await syncJobManagerAlarm({
					env: ctx.env,
					userId: user.userId,
				})
			} catch (syncError) {
				console.error('[job_upsert] failed to sync job manager alarm', {
					userId: user.userId,
					jobId: result.id,
					syncError,
				})
			}
			return result
		},
	},
)
