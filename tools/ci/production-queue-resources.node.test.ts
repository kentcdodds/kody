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
		platformFeedbackDispatchQueueName: 'kody-platform-feedback-dispatch',
		platformFeedbackDispatchDeadLetterQueueName:
			'kody-platform-feedback-dispatch-dlq',
		communityActivityDispatchQueueName: 'kody-community-activity-dispatch',
		communityActivityDispatchDeadLetterQueueName:
			'kody-community-activity-dispatch-dlq',
	})

	const missingFeedbackConsumer = createProductionEnv()
	missingFeedbackConsumer.queues.consumers.pop()
	expect(() =>
		parseProductionQueueResources({
			productionEnv: missingFeedbackConsumer,
			configPath: 'wrangler.jsonc',
		}),
	).toThrow('exactly three production Queue consumers')

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
	missingCommunityProducer.queues.producers.pop()
	expect(() =>
		parseProductionQueueResources({
			productionEnv: missingCommunityProducer,
			configPath: 'wrangler.jsonc',
		}),
	).toThrow(
		'must bind "COMMUNITY_ACTIVITY_DISPATCH_QUEUE" to "kody-community-activity-dispatch"',
	)
})
