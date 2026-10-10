import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import {
	listProductionBoundQueueProducers,
	type ProductionBoundQueueProducer,
} from './production-queue-resources.ts'
import { parseJsonc, truncateWithSuffix } from './resource-utils.ts'

/**
 * Production origin producer bindings that preview does not provision.
 *
 * Package events stay inline when the binding is absent
 * (`packages/worker/src/package-invocations/subscription-dispatch.ts`).
 * Scheduled maintenance stays inline on the preview jobs worker
 * (`packages/jobs-worker/src/scheduled.ts`); that queue is not an origin
 * producer, so it is not in this set.
 *
 * Every other origin producer is created per preview. A new production
 * producer is previewed unless it is added here with an inline fallback.
 */
export const previewInlineOnlyQueueBindings = new Set([
	'PACKAGE_EVENTS_DISPATCH_QUEUE',
])

const previewQueueNameMaxLength = 63

const originWranglerConfigPath = fileURLToPath(
	new URL('../../packages/worker/wrangler.jsonc', import.meta.url),
)

export type PreviewQueueBinding = {
	binding: string
	queue: string
	deadLetterQueue: string
}

let cachedOriginProducers: Array<ProductionBoundQueueProducer> | undefined

export function loadOriginProductionQueueProducers(
	configPath = originWranglerConfigPath,
) {
	if (configPath === originWranglerConfigPath && cachedOriginProducers) {
		return cachedOriginProducers
	}
	const config = parseJsonc<Record<string, unknown>>(
		readFileSync(configPath, 'utf8'),
	)
	const env = config.env
	if (!env || typeof env !== 'object' || Array.isArray(env)) {
		throw new Error(`wrangler config "${configPath}" is missing "env".`)
	}
	const productionEnv = (env as Record<string, unknown>).production
	if (
		!productionEnv ||
		typeof productionEnv !== 'object' ||
		Array.isArray(productionEnv)
	) {
		throw new Error(
			`wrangler config "${configPath}" is missing "env.production".`,
		)
	}
	const producers = listProductionBoundQueueProducers({
		productionEnv: productionEnv as Record<string, unknown>,
		configPath,
	})
	if (configPath === originWranglerConfigPath) {
		cachedOriginProducers = producers
	}
	return producers
}

/**
 * `kody-webhook-dispatch` on worker `kody-pr-42` becomes
 * `kody-pr-42-webhook-dispatch`. Names that would exceed 63 characters keep
 * the production suffix and a short hash of the full worker name so two long
 * branch slugs that share a prefix do not bind the same queue.
 */
export function previewQueueName(
	workerName: string,
	productionQueueName: string,
) {
	if (!productionQueueName.startsWith('kody-')) {
		throw new Error(
			`Production queue "${productionQueueName}" must start with "kody-" so preview names stay derived from it.`,
		)
	}
	const suffix = productionQueueName.slice('kody'.length)
	const full = `${workerName}${suffix}`
	if (full.length <= previewQueueNameMaxLength) return full
	const digest = createHash('sha256').update(workerName).digest('hex')
	for (const digestLength of [8, 6, 4]) {
		const hashed = truncateWithSuffix(
			workerName,
			`-${digest.slice(0, digestLength)}${suffix}`,
			previewQueueNameMaxLength,
		)
		if (
			hashed.endsWith(suffix) &&
			hashed.includes(digest.slice(0, digestLength)) &&
			/^kody-(?:pr-\d+|branch-[a-z0-9]+)(?:-[a-z0-9]+)*$/.test(hashed)
		) {
			return hashed
		}
	}
	throw new Error(
		`Cannot build a unique preview queue name for "${workerName}" from "${productionQueueName}".`,
	)
}

export function planPreviewOriginQueues(workerName: string) {
	const bindings: Array<PreviewQueueBinding> = []
	for (const producer of loadOriginProductionQueueProducers()) {
		if (previewInlineOnlyQueueBindings.has(producer.binding)) continue
		const queue = previewQueueName(workerName, producer.queue)
		const deadLetterQueue = previewQueueName(
			workerName,
			producer.deadLetterQueue,
		)
		bindings.push({
			binding: producer.binding,
			queue,
			deadLetterQueue,
		})
	}
	return {
		bindings,
		queueNames: bindings.flatMap((binding) => [
			binding.queue,
			binding.deadLetterQueue,
		]),
	}
}
