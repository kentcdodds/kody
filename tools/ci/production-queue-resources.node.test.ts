import { readFileSync } from 'node:fs'
import { expect, test } from 'vitest'
import { parseProductionQueueResources } from './production-queue-resources.ts'
import { parseJsonc } from './resource-utils.ts'

function createProductionEnv() {
	return {
		queues: {
			producers: [
				{
					binding: 'PLATFORM_FEEDBACK_DISPATCH_QUEUE',
					queue: 'kody-platform-feedback-dispatch',
				},
				{
					binding: 'COMMUNITY_ACTIVITY_DISPATCH_QUEUE',
					queue: 'kody-community-activity-dispatch',
				},
				{
					binding: 'SCHEDULED_DISPATCH_QUEUE',
					queue: 'kody-scheduled-dispatch',
				},
				{
					binding: 'PACKAGE_EVENTS_DISPATCH_QUEUE',
					queue: 'kody-package-events-dispatch',
				},
				{
					binding: 'WEBHOOK_DISPATCH_QUEUE',
					queue: 'kody-webhook-dispatch',
				},
			],
			consumers: [
				{
					queue: 'kody-email-delivery',
					max_batch_size: 10,
					max_batch_timeout: 5,
					max_retries: 3,
					dead_letter_queue: 'kody-email-delivery-dlq',
				},
				{
					queue: 'kody-artifacts-repo-events',
					max_batch_size: 10,
					max_batch_timeout: 5,
					max_retries: 3,
					dead_letter_queue: 'kody-artifacts-repo-events-dlq',
				},
				{
					queue: 'kody-platform-feedback-dispatch',
					max_batch_size: 10,
					max_batch_timeout: 5,
					max_retries: 3,
					dead_letter_queue: 'kody-platform-feedback-dispatch-dlq',
				},
				{
					queue: 'kody-community-activity-dispatch',
					max_batch_size: 10,
					max_batch_timeout: 5,
					max_retries: 3,
					dead_letter_queue: 'kody-community-activity-dispatch-dlq',
				},
				{
					queue: 'kody-scheduled-dispatch',
					max_batch_size: 1,
					max_batch_timeout: 0,
					max_retries: 3,
					max_concurrency: 16,
					dead_letter_queue: 'kody-scheduled-dispatch-dlq',
				},
				{
					queue: 'kody-package-events-dispatch',
					max_batch_size: 10,
					max_batch_timeout: 5,
					max_retries: 3,
					max_concurrency: 16,
					dead_letter_queue: 'kody-package-events-dispatch-dlq',
				},
				{
					queue: 'kody-webhook-dispatch',
					max_batch_size: 1,
					max_batch_timeout: 5,
					max_retries: 10,
					max_concurrency: 16,
					dead_letter_queue: 'kody-webhook-dispatch-dlq',
				},
			],
		},
	}
}

test('production queue config requires all consumers and consistent producers', () => {
	const wranglerConfig = parseJsonc<{
		env: { production: Record<string, unknown> }
	}>(
		readFileSync(
			new URL('../../packages/worker/wrangler.jsonc', import.meta.url),
			'utf8',
		),
	)
	expect(
		parseProductionQueueResources({
			productionEnv: wranglerConfig.env.production,
			configPath: 'packages/worker/wrangler.jsonc',
		}),
	).toEqual({
		emailDeliveryQueueName: 'kody-email-delivery',
		emailDeliveryDeadLetterQueueName: 'kody-email-delivery-dlq',
		artifactsRepoEventsQueueName: 'kody-artifacts-repo-events',
		artifactsRepoEventsDeadLetterQueueName: 'kody-artifacts-repo-events-dlq',
		platformFeedbackDispatchQueueName: 'kody-platform-feedback-dispatch',
		platformFeedbackDispatchDeadLetterQueueName:
			'kody-platform-feedback-dispatch-dlq',
		communityActivityDispatchQueueName: 'kody-community-activity-dispatch',
		communityActivityDispatchDeadLetterQueueName:
			'kody-community-activity-dispatch-dlq',
		scheduledDispatchQueueName: 'kody-scheduled-dispatch',
		scheduledDispatchDeadLetterQueueName: 'kody-scheduled-dispatch-dlq',
		packageEventsDispatchQueueName: 'kody-package-events-dispatch',
		packageEventsDispatchDeadLetterQueueName:
			'kody-package-events-dispatch-dlq',
		webhookDispatchQueueName: 'kody-webhook-dispatch',
		webhookDispatchDeadLetterQueueName: 'kody-webhook-dispatch-dlq',
	})

	const missingFeedbackConsumer = createProductionEnv()
	missingFeedbackConsumer.queues.consumers.pop()
	expect(() =>
		parseProductionQueueResources({
			productionEnv: missingFeedbackConsumer,
			configPath: 'wrangler.jsonc',
		}),
	).toThrow('exactly 7 production Queue consumers')

	const mismatchedProducer = createProductionEnv()
	mismatchedProducer.queues.producers[0] = {
		binding: 'PLATFORM_FEEDBACK_DISPATCH_QUEUE',
		queue: 'wrong-queue',
	}
	expect(() =>
		parseProductionQueueResources({
			productionEnv: mismatchedProducer,
			configPath: 'wrangler.jsonc',
		}),
	).toThrow(
		'must bind "PLATFORM_FEEDBACK_DISPATCH_QUEUE" to "kody-platform-feedback-dispatch"',
	)

	const missingCommunityProducer = createProductionEnv()
	missingCommunityProducer.queues.producers =
		missingCommunityProducer.queues.producers.filter(
			(producer) => producer.binding !== 'COMMUNITY_ACTIVITY_DISPATCH_QUEUE',
		)
	expect(() =>
		parseProductionQueueResources({
			productionEnv: missingCommunityProducer,
			configPath: 'wrangler.jsonc',
		}),
	).toThrow(
		'must bind "COMMUNITY_ACTIVITY_DISPATCH_QUEUE" to "kody-community-activity-dispatch"',
	)

	const missingScheduledProducer = createProductionEnv()
	missingScheduledProducer.queues.producers =
		missingScheduledProducer.queues.producers.filter(
			(producer) => producer.binding !== 'SCHEDULED_DISPATCH_QUEUE',
		)
	expect(() =>
		parseProductionQueueResources({
			productionEnv: missingScheduledProducer,
			configPath: 'wrangler.jsonc',
		}),
	).toThrow('must bind "SCHEDULED_DISPATCH_QUEUE" to "kody-scheduled-dispatch"')

	const missingPackageEventsProducer = createProductionEnv()
	missingPackageEventsProducer.queues.producers =
		missingPackageEventsProducer.queues.producers.filter(
			(producer) => producer.binding !== 'PACKAGE_EVENTS_DISPATCH_QUEUE',
		)
	expect(() =>
		parseProductionQueueResources({
			productionEnv: missingPackageEventsProducer,
			configPath: 'wrangler.jsonc',
		}),
	).toThrow(
		'must bind "PACKAGE_EVENTS_DISPATCH_QUEUE" to "kody-package-events-dispatch"',
	)

	for (const invalidSettings of [
		{ max_batch_size: 2 },
		{ max_batch_timeout: 1 },
		{ max_concurrency: 1 },
	]) {
		const invalidScheduledConsumer = createProductionEnv()
		Object.assign(
			invalidScheduledConsumer.queues.consumers.find(
				(consumer) => consumer.queue === 'kody-scheduled-dispatch',
			)!,
			invalidSettings,
		)
		expect(() =>
			parseProductionQueueResources({
				productionEnv: invalidScheduledConsumer,
				configPath: 'wrangler.jsonc',
			}),
		).toThrow(
			'invalid production consumer settings for "kody-scheduled-dispatch"',
		)
	}
})
