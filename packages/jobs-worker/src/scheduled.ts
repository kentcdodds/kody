import * as Sentry from '@sentry/cloudflare'
import { isRetryableD1LockError } from '@kody-internal/shared/d1-retry.ts'
import {
	getScheduledLaneCadence,
	isJobsWorkerLocalLane,
	parseScheduledLaneMessage,
	resolveScheduledLaneQueueAction,
	type ScheduledLaneMessage,
	type ScheduledLaneOutcome,
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
}): Promise<ScheduledLaneOutcome> {
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
			const message = {
				lane,
				scheduledTime: input.controller.scheduledTime,
				cron: input.controller.cron,
			} satisfies ScheduledLaneMessage
			await runInlineScheduledLane({
				env: input.env,
				message,
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
		await runInlineScheduledLane({
			env: input.env,
			message,
		})
	}
}

async function runInlineScheduledLane(input: {
	env: JobsWorkerEnv
	message: ScheduledLaneMessage
}) {
	const outcome = await runScheduledLaneWithFailureIsolation(input)
	if (outcome === 'completed') return
	console.error(`scheduled_lane_inline_${outcome}`, {
		lane: input.message.lane,
		scheduledTime: input.message.scheduledTime,
		cron: input.message.cron,
		outcome,
	})
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
		const outcome = await runScheduledLaneWithFailureIsolation({
			env,
			message,
		})
		const decision = resolveScheduledLaneQueueAction({
			outcome,
			attempts: queueMessage.attempts,
		})
		if (decision.action === 'retry') {
			if (decision.reason === 'retry_exhausted') {
				console.error('scheduled_lane_retry_exhausted', {
					lane: message.lane,
					scheduledTime: message.scheduledTime,
					cron: message.cron,
					attempts: queueMessage.attempts,
					outcome,
				})
				Sentry.withScope((scope) => {
					scope.setTag('scheduled.lane', message.lane)
					scope.setTag('scheduled.queue_action', 'retry_exhausted')
					scope.setContext('scheduled', {
						lane: message.lane,
						scheduledTime: new Date(message.scheduledTime).toISOString(),
						cron: message.cron,
						attempts: queueMessage.attempts,
						outcome,
					})
					Sentry.captureMessage(
						`scheduled_lane_retry_exhausted lane=${message.lane}`,
					)
				})
			}
			queueMessage.retry({ delaySeconds: decision.delaySeconds })
			continue
		}
		if (decision.reason === 'terminal_failure') {
			console.error('scheduled_lane_terminal_not_retried', {
				lane: message.lane,
				scheduledTime: message.scheduledTime,
				cron: message.cron,
				attempts: queueMessage.attempts,
				outcome,
			})
		}
		queueMessage.ack()
	}
}
