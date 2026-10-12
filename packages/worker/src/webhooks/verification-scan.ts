import { type OwnerId } from '@kody-internal/shared/owner-person-ids.ts'
import { getAppBaseUrl } from '#worker/app-base-url.ts'
import { listPackageWebhooks } from '#worker/package-registry/manifest.ts'
import { loadPackageManifestBySourceId } from '#worker/package-registry/source.ts'
import { andLiveDeletedAtSql } from '#worker/soft-delete/live-sql.ts'
import {
	mapWithConcurrency,
	readWebhookDeliveries,
	webhookOwnerScanConcurrency,
} from './delivery-outcomes.ts'

const endpointPageSize = 1_000

/**
 * `url_secret_only`: the manifest declares the webhook without `verification`.
 * `signature`: it declares `verification`. `undeclared`: the manifest no longer
 * declares it, so ingress refuses deliveries. `manifest_unavailable`: the
 * package or its manifest could not be read.
 */
export type WebhookVerificationStatus =
	| 'url_secret_only'
	| 'signature'
	| 'undeclared'
	| 'manifest_unavailable'

export type WebhookVerificationScanEndpoint = {
	ownerId: OwnerId
	ownerSlug: string | null
	endpointId: string
	packageId: string
	packageKodyId: string | null
	webhookName: string
	status: WebhookVerificationStatus
	verification: {
		type: string
		header: string
		secretName: string | null
	} | null
	delivered: number
	lastDeliveredAt: string | null
}

export type WebhookVerificationScan = {
	since: string
	endpointsScanned: number
	ownersFailed: Array<OwnerId>
	truncated: boolean
	totals: Record<WebhookVerificationStatus, number> & {
		urlSecretOnlyOwners: number
		urlSecretOnlyDelivered: number
	}
	endpoints: Array<WebhookVerificationScanEndpoint>
}

type LiveEndpointRow = {
	id: string
	user_id: string
	package_id: string
	webhook_name: string
	owner_slug: string | null
	kody_id: string | null
	source_id: string | null
}

async function listLiveWebhookEndpoints(db: D1Database) {
	const rows: Array<LiveEndpointRow> = []
	let after = ''
	for (;;) {
		const page =
			(
				await db
					.prepare(
						`SELECT e.id, e.user_id, e.package_id, e.webhook_name,
							o.slug AS owner_slug, p.kody_id, p.source_id
						 FROM webhook_endpoints e
						 LEFT JOIN orgs o ON o.id = e.user_id
						 LEFT JOIN saved_packages p
							ON p.id = e.package_id AND p.user_id = e.user_id${andLiveDeletedAtSql('p')}
						 WHERE e.id > ?${andLiveDeletedAtSql('e')} AND e.enabled = 1
						 ORDER BY e.id
						 LIMIT ?`,
					)
					.bind(after, endpointPageSize)
					.all<LiveEndpointRow>()
			).results ?? []
		rows.push(...page)
		if (page.length < endpointPageSize) return rows
		after = page[page.length - 1]!.id
	}
}

/**
 * Which live webhook URLs still rely on URL-secret-only auth, judged from each
 * package's current manifest the same way ingress reads it, with successful
 * deliveries since `since` from each owner's RunLog. The rescan for
 * https://github.com/kentcdodds/kody/issues/3477.
 */
export async function scanWebhookVerification(input: {
	env: Env
	since: string
	includeSignature: boolean
}): Promise<WebhookVerificationScan> {
	const since = new Date(input.since).toISOString()
	const rows = await listLiveWebhookEndpoints(input.env.APP_DB)
	const baseUrl = getAppBaseUrl({ env: input.env })

	const manifestKeys = new Map<string, { userId: string; sourceId: string }>()
	for (const row of rows) {
		if (row.source_id) {
			manifestKeys.set(`${row.user_id}:${row.source_id}`, {
				userId: row.user_id,
				sourceId: row.source_id,
			})
		}
	}
	const manifests = new Map<
		string,
		ReturnType<typeof listPackageWebhooks> | null
	>()
	await mapWithConcurrency(
		[...manifestKeys.entries()],
		webhookOwnerScanConcurrency,
		async ([key, source]) => {
			try {
				const loaded = await loadPackageManifestBySourceId({
					env: input.env,
					baseUrl,
					userId: source.userId,
					sourceId: source.sourceId,
				})
				manifests.set(key, listPackageWebhooks(loaded.manifest))
			} catch (cause) {
				console.warn('webhook-verification-scan-manifest-failed', {
					ownerId: source.userId,
					sourceId: source.sourceId,
					error: cause,
				})
				manifests.set(key, null)
			}
		},
	)

	const endpoints: Array<WebhookVerificationScanEndpoint> = rows.map((row) => {
		const webhooks = row.source_id
			? manifests.get(`${row.user_id}:${row.source_id}`)
			: null
		const declared = webhooks?.find(
			(webhook) => webhook.name === row.webhook_name,
		)
		const status: WebhookVerificationStatus = !webhooks
			? 'manifest_unavailable'
			: !declared
				? 'undeclared'
				: declared.verification
					? 'signature'
					: 'url_secret_only'
		return {
			ownerId: row.user_id as OwnerId,
			ownerSlug: row.owner_slug,
			endpointId: row.id,
			packageId: row.package_id,
			packageKodyId: row.kody_id,
			webhookName: row.webhook_name,
			status,
			verification: declared?.verification
				? {
						type: declared.verification.type,
						header: declared.verification.header,
						secretName: declared.verification.secretName ?? null,
					}
				: null,
			delivered: 0,
			lastDeliveredAt: null,
		}
	})

	const reported = endpoints.filter(
		(endpoint) => input.includeSignature || endpoint.status !== 'signature',
	)
	const byOwner = new Map<OwnerId, Array<WebhookVerificationScanEndpoint>>()
	for (const endpoint of reported) {
		const owned = byOwner.get(endpoint.ownerId) ?? []
		owned.push(endpoint)
		byOwner.set(endpoint.ownerId, owned)
	}
	const deliveryScans = await mapWithConcurrency(
		[...byOwner.entries()],
		webhookOwnerScanConcurrency,
		async ([ownerId, owned]) => {
			try {
				const result = await readWebhookDeliveries({
					env: input.env,
					ownerId,
					filter: { since },
				})
				const byEndpointId = new Map(
					owned.map((endpoint) => [endpoint.endpointId, endpoint]),
				)
				for (const delivery of result.deliveries) {
					const endpoint = delivery.endpointId
						? byEndpointId.get(delivery.endpointId)
						: undefined
					if (!endpoint || !delivery.delivered) continue
					endpoint.delivered += 1
					if (
						endpoint.lastDeliveredAt === null ||
						delivery.startedAt > endpoint.lastDeliveredAt
					) {
						endpoint.lastDeliveredAt = delivery.startedAt
					}
				}
				return { ownerId, truncated: result.truncated, failed: false }
			} catch (cause) {
				console.warn('webhook-verification-scan-owner-failed', {
					ownerId,
					error: cause,
				})
				return { ownerId, truncated: false, failed: true }
			}
		},
	)

	const urlSecretOnly = endpoints.filter(
		(endpoint) => endpoint.status === 'url_secret_only',
	)
	const countStatus = (status: WebhookVerificationStatus) =>
		endpoints.filter((endpoint) => endpoint.status === status).length
	reported.sort(
		(left, right) =>
			(left.ownerSlug ?? left.ownerId).localeCompare(
				right.ownerSlug ?? right.ownerId,
			) ||
			(left.packageKodyId ?? '').localeCompare(right.packageKodyId ?? '') ||
			left.webhookName.localeCompare(right.webhookName),
	)
	return {
		since,
		endpointsScanned: endpoints.length,
		ownersFailed: deliveryScans
			.filter((scan) => scan.failed)
			.map((scan) => scan.ownerId),
		truncated: deliveryScans.some((scan) => scan.truncated),
		totals: {
			url_secret_only: urlSecretOnly.length,
			signature: countStatus('signature'),
			undeclared: countStatus('undeclared'),
			manifest_unavailable: countStatus('manifest_unavailable'),
			urlSecretOnlyOwners: new Set(urlSecretOnly.map((row) => row.ownerId))
				.size,
			urlSecretOnlyDelivered: urlSecretOnly.reduce(
				(sum, row) => sum + row.delivered,
				0,
			),
		},
		endpoints: reported,
	}
}
