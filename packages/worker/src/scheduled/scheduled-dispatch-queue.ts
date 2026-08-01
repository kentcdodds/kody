import {
	getScheduledLanes,
	isScheduledLaneName,
	runScheduledLaneWithFailureIsolation,
	type ScheduledLaneMessage,
} from './scheduled-lanes.ts'

const scheduledLaneRetryDelaySeconds = 30

function parseScheduledLaneMessage(body: unknown): ScheduledLaneMessage | null {
	if (!body || typeof body !== 'object' || Array.isArray(body)) return null
	const record = body as Record<string, unknown>
	const lane = record['lane']
	const scheduledTime = record['scheduledTime']
	const cron = record['cron']
	if (
		Object.keys(record).length !== 3 ||
		!isScheduledLaneName(lane) ||
		typeof scheduledTime !== 'number' ||
		!Number.isFinite(scheduledTime) ||
		typeof cron !== 'string'
	) {
		return null
	}
	return { lane, scheduledTime, cron }
}

export async function dispatchScheduledLanes(input: {
	controller: ScheduledController
	env: Env
}) {
	const scheduledAt = new Date(input.controller.scheduledTime)
	const lanes = getScheduledLanes({ env: input.env, scheduledAt })
	const queue = (input.env as Partial<Env>).SCHEDULED_DISPATCH_QUEUE
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

	await Promise.all(
		lanes.map(async (lane) => {
			try {
				await queue.send({
					lane,
					scheduledTime: input.controller.scheduledTime,
					cron: input.controller.cron,
				} satisfies ScheduledLaneMessage)
			} catch (error) {
				console.error(`scheduled_lane_dispatch_failed lane=${lane}`, error)
			}
		}),
	)
}

export async function handleScheduledDispatchQueue(
	batch: MessageBatch<unknown>,
	env: Env,
	_ctx: ExecutionContext,
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
		const status = await runScheduledLaneWithFailureIsolation({ env, message })
		if (status === 'completed') {
			queueMessage.ack()
			continue
		}
		queueMessage.retry({ delaySeconds: scheduledLaneRetryDelaySeconds })
	}
}
