import * as Sentry from '@sentry/cloudflare'
import { isRetryableD1LockError } from '@kody-internal/shared/d1-retry.ts'
import {
	getScheduledLaneCadence,
	isJobsWorkerLocalLane,
	parseScheduledLaneMessage,
	type ScheduledLaneMessage,
} from '@kody-internal/shared/jobs/scheduled-lanes.ts'
import { type JobsWorkerEnv } from './env.ts'
import { runJobScheduleWatchdogTick } from './watchdog.ts'

/**
 * Execute one scheduled lane. Lanes the jobs worker owns run locally against
 * the jobs database and JobManager namespace; every other lane (the platform
 * lanes welded to the main worker's subsystems) is forwarded to
 * `JobsHost.runScheduledLane`, which applies its own failure isolation.
 */
export async function runScheduledLaneWithFailureIsolation(input: {
	env: JobsWorkerEnv
	message: ScheduledLaneMessage
}): Promise<'completed' | 'd1_lock_contention' | 'failed'> {
	const scheduledAt = new Date(input.message.scheduledTime)
	try {
		if (isJobsWorkerLocalLane(input.message.lane)) {
			await runJobScheduleWatchdogTick({
				env: input.env,
				now: scheduledAt,
			})
			return 'completed'
		}
		return await input.env.HOST.runScheduledLane(input.message)
	} catch (error) {
		if (isRetryableD1LockError(error)) {
			console.warn(
				`scheduled_lane_d1_lock_contention lane=${input.message.lane}`,
				error,
			)
			return 'd1_lock_contention'
		}
		console.error(`scheduled_lane_failed lane=${input.message.lane}`, error)
		Sentry.withScope((scope) => {
			scope.setTag('scheduled.lane', input.message.lane)
			scope.setContext('scheduled', {
				lane: input.message.lane,
				scheduledTime: scheduledAt.toISOString(),
				cron: input.message.cron,
			})
			Sentry.captureException(error)
		})
		return 'failed'
	}
}

export async function dispatchScheduledLanes(input: {
	controller: ScheduledController
	env: JobsWorkerEnv
}) {
	const scheduledAt = new Date(input.controller.scheduledTime)
	const lanes = getScheduledLaneCadence(scheduledAt)
	const queue = input.env.SCHEDULED_DISPATCH_QUEUE
	if (!queue) {
		for (const lane of lanes) {
			await runScheduledLaneWithFailureIsolation({
				env: input.env,
				message: {
					lane,
					scheduledTime: input.controller.scheduledTime,
					cron: input.controller.cron,
				},
			})
		}
		return
	}

	const failedMessages = await Promise.all(
		lanes.map(async (lane) => {
			const message = {
				lane,
				scheduledTime: input.controller.scheduledTime,
				cron: input.controller.cron,
			} satisfies ScheduledLaneMessage
			try {
				await queue.send(message)
				return null
			} catch (error) {
				console.error(`scheduled_lane_dispatch_failed lane=${lane}`, error)
				Sentry.withScope((scope) => {
					scope.setTag('scheduled.lane', lane)
					scope.setContext('scheduled_dispatch', {
						lane,
						scheduledTime: scheduledAt.toISOString(),
						cron: input.controller.cron,
					})
					Sentry.captureException(error)
				})
				return message
			}
		}),
	)
	for (const message of failedMessages) {
		if (!message) continue
		await runScheduledLaneWithFailureIsolation({
			env: input.env,
			message,
		})
	}
}

export async function handleScheduledDispatchQueue(
	batch: MessageBatch<unknown>,
	env: JobsWorkerEnv,
) {
	for (const queueMessage of batch.messages) {
		const message = parseScheduledLaneMessage(queueMessage.body)
		if (!message) {
			console.error('scheduled_lane_message_invalid', {
				queueMessageId: queueMessage.id,
			})
			queueMessage.ack()
			continue
		}
		await runScheduledLaneWithFailureIsolation({ env, message })
		queueMessage.ack()
	}
}
