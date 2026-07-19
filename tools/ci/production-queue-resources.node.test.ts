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
			],
		},
	}
}

test('production queue config requires both consumers and a consistent platform feedback producer', () => {
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
	})

	const missingFeedbackConsumer = createProductionEnv()
	missingFeedbackConsumer.queues.consumers.pop()
	expect(() =>
		parseProductionQueueResources({
			productionEnv: missingFeedbackConsumer,
			configPath: 'wrangler.jsonc',
		}),
	).toThrow('exactly two production Queue consumers')

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
})
