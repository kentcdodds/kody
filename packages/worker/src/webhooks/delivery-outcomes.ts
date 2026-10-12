import { type OwnerId } from '@kody-internal/shared/owner-person-ids.ts'
import { listRunRecords } from '#worker/run-records/service.ts'
import {
	runRecordMaxPageSize,
	type RunRecord,
	type RunRecordFilter,
} from '#worker/run-records/types.ts'
import { andLiveDeletedAtSql } from '#worker/soft-delete/live-sql.ts'

/**
 * Webhook delivery outcomes live in each owner's RunLog Durable Object, so
 * fleet reads fan out per owner that has a minted webhook URL.
 */
export const webhookOwnerScanConcurrency = 8
export const webhookOwnerScanMaxOwners = 2_000
/** RunLog keeps at most 2,000 runs per owner: 20 full pages. */
const maxPagesPerQuery = 20

export type WebhookOwner = {
	ownerId: OwnerId
	slug: string | null
}

export async function listWebhookOwners(input: {
	db: D1Database
	enabledOnly: boolean
}): Promise<{ owners: Array<WebhookOwner>; truncated: boolean }> {
	const rows = await input.db
		.prepare(
			`SELECT e.user_id AS owner_id, MAX(o.slug) AS slug
			 FROM webhook_endpoints e
			 LEFT JOIN orgs o ON o.id = e.user_id
			 WHERE 1 = 1${andLiveDeletedAtSql('e')}${input.enabledOnly ? ' AND e.enabled = 1' : ''}
			 GROUP BY e.user_id
			 ORDER BY e.user_id
			 LIMIT ?`,
		)
		.bind(webhookOwnerScanMaxOwners + 1)
		.all<{ owner_id: string; slug: string | null }>()
	const owners = (rows.results ?? [])
		.filter((row) => typeof row.owner_id === 'string' && row.owner_id !== '')
		.map((row) => ({ ownerId: row.owner_id as OwnerId, slug: row.slug }))
	const truncated = owners.length > webhookOwnerScanMaxOwners
	return {
		owners: truncated ? owners.slice(0, webhookOwnerScanMaxOwners) : owners,
		truncated,
	}
}

export type WebhookDelivery = {
	endpointKey: string
	endpointId: string | null
	webhookName: string | null
	packageId: string | null
	kodyId: string | null
	startedAt: string
	delivered: boolean
	httpStatus: number | null
	error: string | null
}

export function toWebhookDelivery(run: RunRecord): WebhookDelivery {
	const endpointId =
		typeof run.metadata['endpointId'] === 'string'
			? run.metadata['endpointId']
			: null
	const httpStatus =
		typeof run.metadata['httpStatus'] === 'number'
			? run.metadata['httpStatus']
			: null
	return {
		endpointKey: endpointId ?? `${run.packageId ?? ''}:${run.name ?? ''}`,
		endpointId,
		webhookName: run.name,
		packageId: run.packageId,
		kodyId: run.kodyId,
		startedAt: run.startedAt,
		delivered: run.status === 'success',
		httpStatus,
		error: run.errorMessage,
	}
}

/**
 * Newest-first webhook deliveries for one owner. `stopWhen` ends the walk
 * early; `truncated` means the page cap was hit before the window ended.
 */
export async function readWebhookDeliveries(input: {
	env: Env
	ownerId: OwnerId
	filter: Omit<RunRecordFilter, 'surface' | 'errorTriage'>
	stopWhen?: (delivery: WebhookDelivery) => boolean
}): Promise<{ deliveries: Array<WebhookDelivery>; truncated: boolean }> {
	const deliveries: Array<WebhookDelivery> = []
	let cursor: string | null = null
	for (let page = 0; page < maxPagesPerQuery; page++) {
		const result = await listRunRecords({
			env: input.env,
			userId: input.ownerId,
			filter: { ...input.filter, surface: 'webhook', errorTriage: null },
			limit: runRecordMaxPageSize,
			cursor,
		})
		for (const run of result.runs) {
			if (run.status === 'running') continue
			const delivery = toWebhookDelivery(run)
			deliveries.push(delivery)
			if (input.stopWhen?.(delivery)) {
				return { deliveries, truncated: false }
			}
		}
		cursor = result.nextCursor
		if (!cursor) return { deliveries, truncated: false }
	}
	return { deliveries, truncated: true }
}

export async function mapWithConcurrency<T, R>(
	items: ReadonlyArray<T>,
	concurrency: number,
	mapper: (item: T) => Promise<R>,
): Promise<Array<R>> {
	const results: Array<R> = []
	let next = 0
	const workers = Array.from(
		{ length: Math.min(concurrency, items.length) },
		async () => {
			while (next < items.length) {
				const index = next++
				results[index] = await mapper(items[index]!)
			}
		},
	)
	await Promise.all(workers)
	return results
}
