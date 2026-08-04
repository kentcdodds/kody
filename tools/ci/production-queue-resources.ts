import {
	communityActivityDispatchDeadLetterQueueName,
	communityActivityDispatchQueueBinding,
	communityActivityDispatchQueueName,
} from '../../packages/worker/src/community/activity-dispatch-queue-names.ts'
import {
	packageEventsDispatchDeadLetterQueueName,
	packageEventsDispatchQueueBinding,
	packageEventsDispatchQueueName,
} from '../../packages/worker/src/package-events/dispatch-queue-names.ts'
import {
	platformFeedbackDispatchDeadLetterQueueName,
	platformFeedbackDispatchQueueBinding,
	platformFeedbackDispatchQueueName,
} from '../../packages/worker/src/platform-feedback/dispatch-queue-names.ts'
import {
	artifactsRepoEventsDeadLetterQueueName,
	artifactsRepoEventsQueueName,
} from '../../packages/worker/src/repo/artifacts-event-queue-names.ts'
import {
	scheduledDispatchDeadLetterQueueName,
	scheduledDispatchQueueBinding,
	scheduledDispatchQueueName,
} from '../../packages/worker/src/scheduled/scheduled-dispatch-queue-names.ts'

const emailDeliveryQueueName = 'kody-email-delivery'
const emailDeliveryDeadLetterQueueName = 'kody-email-delivery-dlq'
const expectedMaxBatchSize = 10
const expectedMaxBatchTimeout = 5
const expectedMaxRetries = 3
const expectedConsumerCount = 6

function readQueueConsumer(input: {
	consumers: Array<unknown>
	queueName: string
	deadLetterQueueName: string
	configPath: string
	maxBatchSize?: number
	maxBatchTimeout?: number
	maxConcurrency?: number
}) {
	const value = input.consumers.find((entry) => {
		if (!entry || typeof entry !== 'object' || Array.isArray(entry))
			return false
		return (entry as Record<string, unknown>).queue === input.queueName
	})
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		throw new Error(
			`wrangler config "${input.configPath}" must define the production Queue consumer "${input.queueName}".`,
		)
	}
	const consumer = value as Record<string, unknown>
	if (
		consumer.dead_letter_queue !== input.deadLetterQueueName ||
		consumer.max_batch_size !== (input.maxBatchSize ?? expectedMaxBatchSize) ||
		consumer.max_batch_timeout !==
			(input.maxBatchTimeout ?? expectedMaxBatchTimeout) ||
		consumer.max_retries !== expectedMaxRetries ||
		(input.maxConcurrency !== undefined &&
			consumer.max_concurrency !== input.maxConcurrency)
	) {
		throw new Error(
			`wrangler config "${input.configPath}" has invalid production consumer settings for "${input.queueName}".`,
		)
	}
	return {
		queue: input.queueName,
		deadLetterQueue: input.deadLetterQueueName,
	}
}

function readQueueProducer(input: {
	producers: Array<unknown>
	binding: string
	queueName: string
	configPath: string
}) {
	const producer = input.producers.find((entry) => {
		if (!entry || typeof entry !== 'object' || Array.isArray(entry))
			return false
		return (entry as Record<string, unknown>).binding === input.binding
	})
	if (
		!producer ||
		typeof producer !== 'object' ||
		Array.isArray(producer) ||
		(producer as Record<string, unknown>).queue !== input.queueName
	) {
		throw new Error(
			`wrangler config "${input.configPath}" must bind "${input.binding}" to "${input.queueName}".`,
		)
	}
}

export function parseProductionQueueResources(input: {
	productionEnv: Record<string, unknown>
	configPath: string
}) {
	const queues = input.productionEnv.queues
	if (!queues || typeof queues !== 'object' || Array.isArray(queues)) {
		throw new Error(
			`wrangler config "${input.configPath}" is missing "env.production.queues".`,
		)
	}
	const queueConfig = queues as Record<string, unknown>
	const consumers = queueConfig.consumers
	if (!Array.isArray(consumers) || consumers.length !== expectedConsumerCount) {
		throw new Error(
			`wrangler config "${input.configPath}" must define exactly ${expectedConsumerCount} production Queue consumers.`,
		)
	}
	const emailDelivery = readQueueConsumer({
		consumers,
		queueName: emailDeliveryQueueName,
		deadLetterQueueName: emailDeliveryDeadLetterQueueName,
		configPath: input.configPath,
	})
	const artifactsRepoEvents = readQueueConsumer({
		consumers,
		queueName: artifactsRepoEventsQueueName,
		deadLetterQueueName: artifactsRepoEventsDeadLetterQueueName,
		configPath: input.configPath,
	})
	const platformFeedbackDispatch = readQueueConsumer({
		consumers,
		queueName: platformFeedbackDispatchQueueName,
		deadLetterQueueName: platformFeedbackDispatchDeadLetterQueueName,
		configPath: input.configPath,
	})
	const communityActivityDispatch = readQueueConsumer({
		consumers,
		queueName: communityActivityDispatchQueueName,
		deadLetterQueueName: communityActivityDispatchDeadLetterQueueName,
		configPath: input.configPath,
	})
	const scheduledDispatch = readQueueConsumer({
		consumers,
		queueName: scheduledDispatchQueueName,
		deadLetterQueueName: scheduledDispatchDeadLetterQueueName,
		configPath: input.configPath,
		maxBatchSize: 1,
		maxBatchTimeout: 0,
		maxConcurrency: 16,
	})
	const packageEventsDispatch = readQueueConsumer({
		consumers,
		queueName: packageEventsDispatchQueueName,
		deadLetterQueueName: packageEventsDispatchDeadLetterQueueName,
		configPath: input.configPath,
		maxConcurrency: 16,
	})
	const producers = queueConfig.producers
	if (!Array.isArray(producers)) {
		throw new Error(
			`wrangler config "${input.configPath}" must define production Queue producers.`,
		)
	}
	readQueueProducer({
		producers,
		binding: platformFeedbackDispatchQueueBinding,
		queueName: platformFeedbackDispatchQueueName,
		configPath: input.configPath,
	})
	readQueueProducer({
		producers,
		binding: communityActivityDispatchQueueBinding,
		queueName: communityActivityDispatchQueueName,
		configPath: input.configPath,
	})
	readQueueProducer({
		producers,
		binding: scheduledDispatchQueueBinding,
		queueName: scheduledDispatchQueueName,
		configPath: input.configPath,
	})
	readQueueProducer({
		producers,
		binding: packageEventsDispatchQueueBinding,
		queueName: packageEventsDispatchQueueName,
		configPath: input.configPath,
	})
	return {
		emailDeliveryQueueName: emailDelivery.queue,
		emailDeliveryDeadLetterQueueName: emailDelivery.deadLetterQueue,
		artifactsRepoEventsQueueName: artifactsRepoEvents.queue,
		artifactsRepoEventsDeadLetterQueueName: artifactsRepoEvents.deadLetterQueue,
		platformFeedbackDispatchQueueName: platformFeedbackDispatch.queue,
		platformFeedbackDispatchDeadLetterQueueName:
			platformFeedbackDispatch.deadLetterQueue,
		communityActivityDispatchQueueName: communityActivityDispatch.queue,
		communityActivityDispatchDeadLetterQueueName:
			communityActivityDispatch.deadLetterQueue,
		scheduledDispatchQueueName: scheduledDispatch.queue,
		scheduledDispatchDeadLetterQueueName: scheduledDispatch.deadLetterQueue,
		packageEventsDispatchQueueName: packageEventsDispatch.queue,
		packageEventsDispatchDeadLetterQueueName:
			packageEventsDispatch.deadLetterQueue,
	}
}
