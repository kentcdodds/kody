import { z } from 'zod'
import { defineDomain } from '#mcp/capabilities/define-domain.ts'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { type CapabilityContext } from '#mcp/capabilities/types.ts'
import { jobRunnerRpc, syncJobRunnerFromDb } from '#worker/jobs/job-runner.ts'
import {
	createJobRecord,
	listJobRecords,
	removeJobRecord,
	requireJobRecord,
	updateJobRecord,
} from '#worker/jobs/service.ts'
import {
	jobCapabilityKeywords,
	jobCreateInputSchema,
	jobDetailsSchema,
	jobExecutionSchema,
	jobHistoryEntrySchema,
	jobHistoryInputSchema,
	jobIdInputSchema,
	jobServerExecInputSchema,
	jobUpdateInputSchema,
	requireJobsUser,
} from './shared.ts'

const jobDeleteOutputSchema = z.object({
	job_id: z.string(),
	deleted: z.literal(true),
})

const jobRunNowOutputSchema = z.object({
	job: jobDetailsSchema,
	execution: jobExecutionSchema,
})

const jobServerExecOutputSchema = z.object({
	ok: z.literal(true),
	job_id: z.string(),
	result: z.unknown(),
})

const jobStorageResetOutputSchema = z.object({
	ok: z.literal(true),
	job_id: z.string(),
})

const jobCreateCapability = defineDomainCapability(capabilityDomainNames.jobs, {
	name: 'job_create',
	description:
		'Create a scheduled Durable Object job for the signed-in user. Jobs run agent-authored `class Job extends DurableObject` code on either a cron schedule or fixed interval.',
	keywords: [...jobCapabilityKeywords, 'create'],
	readOnly: false,
	idempotent: false,
	destructive: false,
	inputSchema: jobCreateInputSchema,
	outputSchema: jobDetailsSchema,
	async handler(args, ctx: CapabilityContext) {
		const user = requireJobsUser(ctx)
		const job = await createJobRecord({
			db: ctx.env.APP_DB,
			userId: user.userId,
			data: args,
		})
		const details = await syncJobRunnerFromDb({
			env: ctx.env,
			userId: user.userId,
			jobId: job.id,
			baseUrl: ctx.callerContext.baseUrl,
			recomputeNextRunAt: true,
		})
		if (!details) {
			throw new Error('Unable to configure the created job runner.')
		}
		return details
	},
})

const jobUpdateCapability = defineDomainCapability(capabilityDomainNames.jobs, {
	name: 'job_update',
	description:
		'Patch one existing scheduled job. Rotates `serverCodeId` when serverCode changes and re-arms alarms when schedule-related fields change.',
	keywords: [...jobCapabilityKeywords, 'update', 'patch'],
	readOnly: false,
	idempotent: false,
	destructive: false,
	inputSchema: jobUpdateInputSchema,
	outputSchema: jobDetailsSchema,
	async handler(args, ctx: CapabilityContext) {
		const user = requireJobsUser(ctx)
		const updateResult = await updateJobRecord({
			db: ctx.env.APP_DB,
			userId: user.userId,
			jobId: args.job_id,
			patch: {
				name: args.patch.name,
				serverCode: args.patch.serverCode,
				schedule: args.patch.schedule,
				timezone: args.patch.timezone,
				enabled: args.patch.enabled,
				killSwitchEnabled: args.patch.kill_switch_enabled,
				historyLimit: args.patch.history_limit,
			},
		})
		const details = await syncJobRunnerFromDb({
			env: ctx.env,
			userId: user.userId,
			jobId: args.job_id,
			baseUrl: ctx.callerContext.baseUrl,
			historyLimit: args.patch.history_limit,
			killSwitchEnabled: args.patch.kill_switch_enabled,
			recomputeNextRunAt: updateResult.scheduleChanged,
		})
		if (!details) {
			throw new Error('Unable to synchronize the updated job runner.')
		}
		return details
	},
})

const jobDeleteCapability = defineDomainCapability(capabilityDomainNames.jobs, {
	name: 'job_delete',
	description:
		'Delete a scheduled job record and remove its supervisor Durable Object facet state.',
	keywords: [...jobCapabilityKeywords, 'delete', 'remove'],
	readOnly: false,
	idempotent: false,
	destructive: true,
	inputSchema: jobIdInputSchema,
	outputSchema: jobDeleteOutputSchema,
	async handler(args, ctx: CapabilityContext) {
		const user = requireJobsUser(ctx)
		await requireJobRecord(ctx.env.APP_DB, user.userId, args.job_id)
		await removeJobRecord(ctx.env.APP_DB, user.userId, args.job_id)
		await Promise.allSettled([
			jobRunnerRpc(ctx.env, args.job_id).deleteRunner(),
		])
		return {
			job_id: args.job_id,
			deleted: true as const,
		}
	},
})

const jobListCapability = defineDomainCapability(capabilityDomainNames.jobs, {
	name: 'job_list',
	description:
		'List scheduled jobs for the signed-in user, including next run time, observability counters, and kill-switch state.',
	keywords: [...jobCapabilityKeywords, 'list'],
	readOnly: true,
	idempotent: true,
	destructive: false,
	inputSchema: z.object({}),
	outputSchema: z.array(jobDetailsSchema),
	async handler(_args, ctx: CapabilityContext) {
		const user = requireJobsUser(ctx)
		const jobs = await listJobRecords(ctx.env.APP_DB, user.userId)
		const details = await Promise.all(
			jobs.map((job) =>
				syncJobRunnerFromDb({
					env: ctx.env,
					userId: user.userId,
					jobId: job.id,
					baseUrl: ctx.callerContext.baseUrl,
				}),
			),
		)
		return details.filter((job): job is NonNullable<typeof job> => job != null)
	},
})

const jobGetCapability = defineDomainCapability(capabilityDomainNames.jobs, {
	name: 'job_get',
	description:
		'Get one scheduled job by id, including schedule, enablement, and supervisor-run metadata.',
	keywords: [...jobCapabilityKeywords, 'get'],
	readOnly: true,
	idempotent: true,
	destructive: false,
	inputSchema: jobIdInputSchema,
	outputSchema: jobDetailsSchema,
	async handler(args, ctx: CapabilityContext) {
		const user = requireJobsUser(ctx)
		const details = await syncJobRunnerFromDb({
			env: ctx.env,
			userId: user.userId,
			jobId: args.job_id,
			baseUrl: ctx.callerContext.baseUrl,
		})
		if (!details) {
			throw new Error(`Job "${args.job_id}" was not found.`)
		}
		return details
	},
})

const jobRunNowCapability = defineDomainCapability(capabilityDomainNames.jobs, {
	name: 'job_run_now',
	description:
		'Trigger a scheduled job immediately without waiting for its next alarm and return the execution outcome plus updated supervisor status.',
	keywords: [...jobCapabilityKeywords, 'run now', 'trigger'],
	readOnly: false,
	idempotent: false,
	destructive: false,
	inputSchema: jobIdInputSchema,
	outputSchema: jobRunNowOutputSchema,
	async handler(args, ctx: CapabilityContext) {
		const user = requireJobsUser(ctx)
		const details = await syncJobRunnerFromDb({
			env: ctx.env,
			userId: user.userId,
			jobId: args.job_id,
			baseUrl: ctx.callerContext.baseUrl,
		})
		if (!details) {
			throw new Error(`Job "${args.job_id}" was not found.`)
		}
		const execution = await jobRunnerRpc(ctx.env, args.job_id).runNow()
		return {
			job: await jobRunnerRpc(ctx.env, args.job_id).getDetails(),
			execution,
		}
	},
})

const jobEnableCapability = defineDomainCapability(capabilityDomainNames.jobs, {
	name: 'job_enable',
	description:
		'Enable a scheduled job and re-arm its next alarm from the configured cron or interval schedule.',
	keywords: [...jobCapabilityKeywords, 'enable'],
	readOnly: false,
	idempotent: false,
	destructive: false,
	inputSchema: jobIdInputSchema,
	outputSchema: jobDetailsSchema,
	async handler(args, ctx: CapabilityContext) {
		const user = requireJobsUser(ctx)
		await updateJobRecord({
			db: ctx.env.APP_DB,
			userId: user.userId,
			jobId: args.job_id,
			patch: { enabled: true },
		})
		const details = await syncJobRunnerFromDb({
			env: ctx.env,
			userId: user.userId,
			jobId: args.job_id,
			baseUrl: ctx.callerContext.baseUrl,
			recomputeNextRunAt: true,
		})
		if (!details) {
			throw new Error(`Job "${args.job_id}" was not found.`)
		}
		return details
	},
})

const jobDisableCapability = defineDomainCapability(
	capabilityDomainNames.jobs,
	{
		name: 'job_disable',
		description:
			'Disable a scheduled job so alarms are cleared and future automatic runs are skipped until re-enabled.',
		keywords: [...jobCapabilityKeywords, 'disable'],
		readOnly: false,
		idempotent: false,
		destructive: false,
		inputSchema: jobIdInputSchema,
		outputSchema: jobDetailsSchema,
		async handler(args, ctx: CapabilityContext) {
			const user = requireJobsUser(ctx)
			await updateJobRecord({
				db: ctx.env.APP_DB,
				userId: user.userId,
				jobId: args.job_id,
				patch: { enabled: false },
			})
			const details = await syncJobRunnerFromDb({
				env: ctx.env,
				userId: user.userId,
				jobId: args.job_id,
				baseUrl: ctx.callerContext.baseUrl,
			})
			if (!details) {
				throw new Error(`Job "${args.job_id}" was not found.`)
			}
			return details
		},
	},
)

const jobHistoryCapability = defineDomainCapability(
	capabilityDomainNames.jobs,
	{
		name: 'job_history',
		description:
			'Return recent run history from the job supervisor Durable Object ring buffer, including durations and captured errors.',
		keywords: [...jobCapabilityKeywords, 'history', 'observability'],
		readOnly: true,
		idempotent: true,
		destructive: false,
		inputSchema: jobHistoryInputSchema,
		outputSchema: z.array(jobHistoryEntrySchema),
		async handler(args, ctx: CapabilityContext) {
			const user = requireJobsUser(ctx)
			const details = await syncJobRunnerFromDb({
				env: ctx.env,
				userId: user.userId,
				jobId: args.job_id,
				baseUrl: ctx.callerContext.baseUrl,
			})
			if (!details) {
				throw new Error(`Job "${args.job_id}" was not found.`)
			}
			return await jobRunnerRpc(ctx.env, args.job_id).getHistory(args.limit)
		},
	},
)

const jobStorageResetCapability = defineDomainCapability(
	capabilityDomainNames.jobs,
	{
		name: 'job_storage_reset',
		description:
			'Delete all facet SQLite storage for one scheduled job while keeping the job record and supervisor metadata.',
		keywords: [...jobCapabilityKeywords, 'storage', 'reset'],
		readOnly: false,
		idempotent: false,
		destructive: true,
		inputSchema: jobIdInputSchema,
		outputSchema: jobStorageResetOutputSchema,
		async handler(args, ctx: CapabilityContext) {
			const user = requireJobsUser(ctx)
			const details = await syncJobRunnerFromDb({
				env: ctx.env,
				userId: user.userId,
				jobId: args.job_id,
				baseUrl: ctx.callerContext.baseUrl,
			})
			if (!details) {
				throw new Error(`Job "${args.job_id}" was not found.`)
			}
			await jobRunnerRpc(ctx.env, args.job_id).resetStorage()
			return {
				ok: true as const,
				job_id: args.job_id,
			}
		},
	},
)

const jobServerExecCapability = defineDomainCapability(
	capabilityDomainNames.jobs,
	{
		name: 'job_server_exec',
		description:
			'Compile one-off JavaScript into a throwaway Dynamic Worker that receives an explicit `job.call(methodName, ...args)` bridge to the scheduled job facet. Use it for debugging, repair tasks, or data migrations scoped to that job.',
		keywords: [...jobCapabilityKeywords, 'server', 'exec', 'debug'],
		readOnly: false,
		idempotent: false,
		destructive: false,
		inputSchema: jobServerExecInputSchema,
		outputSchema: jobServerExecOutputSchema,
		async handler(args, ctx: CapabilityContext) {
			const user = requireJobsUser(ctx)
			const details = await syncJobRunnerFromDb({
				env: ctx.env,
				userId: user.userId,
				jobId: args.job_id,
				baseUrl: ctx.callerContext.baseUrl,
			})
			if (!details) {
				throw new Error(`Job "${args.job_id}" was not found.`)
			}
			const result = await jobRunnerRpc(ctx.env, args.job_id).execServer({
				code: args.code,
				params: args.params,
			})
			return {
				ok: true as const,
				job_id: args.job_id,
				result,
			}
		},
	},
)

export const jobsDomain = defineDomain({
	name: capabilityDomainNames.jobs,
	description:
		'Alarm-driven Durable Object jobs that run agent-authored server code on cron or interval schedules with isolated facet SQLite state and supervisor observability.',
	keywords: [...jobCapabilityKeywords],
	capabilities: [
		jobCreateCapability,
		jobUpdateCapability,
		jobDeleteCapability,
		jobListCapability,
		jobGetCapability,
		jobRunNowCapability,
		jobEnableCapability,
		jobDisableCapability,
		jobHistoryCapability,
		jobStorageResetCapability,
		jobServerExecCapability,
	],
})
