import { type OwnerId } from '@kody-internal/shared/owner-person-ids.ts'
import {
	listWebhookOwners,
	mapWithConcurrency,
	readWebhookDeliveries,
	webhookOwnerScanConcurrency,
	type WebhookDelivery,
	type WebhookOwner,
} from './delivery-outcomes.ts'

export type WebhookRejectionEndpoint = {
	ownerId: OwnerId
	ownerSlug: string | null
	endpointId: string | null
	packageId: string | null
	packageKodyId: string | null
	webhookName: string | null
	rejected: number
	delivered: number
	otherErrors: number
	firstRejectedAt: string | null
	lastRejectedAt: string | null
	lastDeliveredAt: string | null
}

export type WebhookRejectionOwner = {
	ownerId: OwnerId
	ownerSlug: string | null
	endpoints: number
	rejected: number
}

export type WebhookRejectionReport = {
	since: string
	until: string | null
	httpStatus: number
	error: string | null
	ownersScanned: number
	ownersFailed: Array<OwnerId>
	/** True when an owner list or a RunLog page cap cut the scan short. */
	truncated: boolean
	totals: { owners: number; endpoints: number; rejected: number }
	owners: Array<WebhookRejectionOwner>
	endpoints: Array<WebhookRejectionEndpoint>
}

/**
 * Who got webhook rejections with `httpStatus` (and `error`, when set) since
 * `since`, per endpoint and per owner. Read-only: it fans out over every
 * owner's RunLog, so it is an admin investigation tool, not a hot path.
 */
export async function buildWebhookRejectionReport(input: {
	env: Env
	since: string
	until?: string | null
	httpStatus: number
	error?: string | null
}): Promise<WebhookRejectionReport> {
	const until = input.until ?? null
	const error = input.error ?? null
	const { owners, truncated: ownersTruncated } = await listWebhookOwners({
		db: input.env.APP_DB,
		enabledOnly: false,
	})
	const scans = await mapWithConcurrency(
		owners,
		webhookOwnerScanConcurrency,
		async (owner) => {
			try {
				const result = await readWebhookDeliveries({
					env: input.env,
					ownerId: owner.ownerId,
					filter: { since: input.since },
				})
				return { owner, ...result, failed: false }
			} catch (cause) {
				console.warn('webhook-rejection-report-owner-failed', {
					ownerId: owner.ownerId,
					error: cause,
				})
				return { owner, deliveries: [], truncated: false, failed: true }
			}
		},
	)

	const endpoints: Array<WebhookRejectionEndpoint> = []
	for (const scan of scans) {
		const inWindow = scan.deliveries.filter(
			(delivery) => until === null || delivery.startedAt < until,
		)
		endpoints.push(
			...tallyOwnerRejections({
				owner: scan.owner,
				deliveries: inWindow,
				httpStatus: input.httpStatus,
				error,
			}),
		)
	}
	endpoints.sort(
		(left, right) =>
			right.rejected - left.rejected ||
			left.ownerId.localeCompare(right.ownerId),
	)

	const byOwner = new Map<OwnerId, WebhookRejectionOwner>()
	for (const endpoint of endpoints) {
		const owner = byOwner.get(endpoint.ownerId) ?? {
			ownerId: endpoint.ownerId,
			ownerSlug: endpoint.ownerSlug,
			endpoints: 0,
			rejected: 0,
		}
		owner.endpoints += 1
		owner.rejected += endpoint.rejected
		byOwner.set(endpoint.ownerId, owner)
	}
	const ownerRows = [...byOwner.values()].sort(
		(left, right) => right.rejected - left.rejected,
	)

	return {
		since: input.since,
		until,
		httpStatus: input.httpStatus,
		error,
		ownersScanned: owners.length,
		ownersFailed: scans
			.filter((scan) => scan.failed)
			.map((scan) => scan.owner.ownerId),
		truncated: ownersTruncated || scans.some((scan) => scan.truncated),
		totals: {
			owners: ownerRows.length,
			endpoints: endpoints.length,
			rejected: endpoints.reduce((sum, row) => sum + row.rejected, 0),
		},
		owners: ownerRows,
		endpoints,
	}
}

export function tallyOwnerRejections(input: {
	owner: WebhookOwner
	deliveries: ReadonlyArray<WebhookDelivery>
	httpStatus: number
	error: string | null
}): Array<WebhookRejectionEndpoint> {
	const rows = new Map<string, WebhookRejectionEndpoint>()
	for (const delivery of input.deliveries) {
		const row = rows.get(delivery.endpointKey) ?? {
			ownerId: input.owner.ownerId,
			ownerSlug: input.owner.slug,
			endpointId: delivery.endpointId,
			packageId: delivery.packageId,
			packageKodyId: delivery.kodyId,
			webhookName: delivery.webhookName,
			rejected: 0,
			delivered: 0,
			otherErrors: 0,
			firstRejectedAt: null,
			lastRejectedAt: null,
			lastDeliveredAt: null,
		}
		rows.set(delivery.endpointKey, row)
		if (delivery.delivered) {
			row.delivered += 1
			row.lastDeliveredAt = maxIso(row.lastDeliveredAt, delivery.startedAt)
		} else if (
			delivery.httpStatus === input.httpStatus &&
			(input.error === null || delivery.error === input.error)
		) {
			row.rejected += 1
			row.firstRejectedAt = minIso(row.firstRejectedAt, delivery.startedAt)
			row.lastRejectedAt = maxIso(row.lastRejectedAt, delivery.startedAt)
		} else {
			row.otherErrors += 1
		}
	}
	return [...rows.values()].filter((row) => row.rejected > 0)
}

function minIso(current: string | null, value: string) {
	return current === null || value < current ? value : current
}

function maxIso(current: string | null, value: string) {
	return current === null || value > current ? value : current
}
