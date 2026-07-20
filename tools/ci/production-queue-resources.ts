import {
	communityActivityDispatchDeadLetterQueueName,
	communityActivityDispatchQueueBinding,
	communityActivityDispatchQueueName,
} from '../../packages/worker/src/community/activity-dispatch-queue-names.ts'
import {
	platformFeedbackDispatchDeadLetterQueueName,
	platformFeedbackDispatchQueueBinding,
	platformFeedbackDispatchQueueName,
} from '../../packages/worker/src/platform-feedback/dispatch-queue-names.ts'

const emailDeliveryQueueName = 'kody-email-delivery'
const emailDeliveryDeadLetterQueueName = 'kody-email-delivery-dlq'
const expectedMaxBatchSize = 10
const expectedMaxBatchTimeout = 5
const expectedMaxRetries = 3

function readQueueConsumer(input: {
	consumers: Array<unknown>
	queueName: string
	deadLetterQueueName: string
	configPath: string
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
		consumer.max_batch_size !== expectedMaxBatchSize ||
		consumer.max_batch_timeout !== expectedMaxBatchTimeout ||
		consumer.max_retries !== expectedMaxRetries
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
	if (!Array.isArray(consumers) || consumers.length !== 3) {
		throw new Error(
			`wrangler config "${input.configPath}" must define exactly three production Queue consumers.`,
		)
	}
	const emailDelivery = readQueueConsumer({
		consumers,
		queueName: emailDeliveryQueueName,
		deadLetterQueueName: emailDeliveryDeadLetterQueueName,
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
	const producers = queueConfig.producers
	if (!Array.isArray(producers)) {
		throw new Error(
			`wrangler config "${input.configPath}" must define production Queue producers.`,
		)
	}
	const platformFeedbackProducer = producers.find((entry) => {
		if (!entry || typeof entry !== 'object' || Array.isArray(entry))
			return false
		return (
			(entry as Record<string, unknown>).binding ===
			platformFeedbackDispatchQueueBinding
		)
	})
	if (
		!platformFeedbackProducer ||
		typeof platformFeedbackProducer !== 'object' ||
		Array.isArray(platformFeedbackProducer) ||
		(platformFeedbackProducer as Record<string, unknown>).queue !==
			platformFeedbackDispatchQueueName
	) {
		throw new Error(
			`wrangler config "${input.configPath}" must bind "${platformFeedbackDispatchQueueBinding}" to "${platformFeedbackDispatchQueueName}".`,
		)
	}
	const communityActivityProducer = producers.find((entry) => {
		if (!entry || typeof entry !== 'object' || Array.isArray(entry))
			return false
		return (
			(entry as Record<string, unknown>).binding ===
			communityActivityDispatchQueueBinding
		)
	})
	if (
		!communityActivityProducer ||
		typeof communityActivityProducer !== 'object' ||
		Array.isArray(communityActivityProducer) ||
		(communityActivityProducer as Record<string, unknown>).queue !==
			communityActivityDispatchQueueName
	) {
		throw new Error(
			`wrangler config "${input.configPath}" must bind "${communityActivityDispatchQueueBinding}" to "${communityActivityDispatchQueueName}".`,
		)
	}
	return {
		emailDeliveryQueueName: emailDelivery.queue,
		emailDeliveryDeadLetterQueueName: emailDelivery.deadLetterQueue,
		platformFeedbackDispatchQueueName: platformFeedbackDispatch.queue,
		platformFeedbackDispatchDeadLetterQueueName:
			platformFeedbackDispatch.deadLetterQueue,
		communityActivityDispatchQueueName: communityActivityDispatch.queue,
		communityActivityDispatchDeadLetterQueueName:
			communityActivityDispatch.deadLetterQueue,
	}
}
