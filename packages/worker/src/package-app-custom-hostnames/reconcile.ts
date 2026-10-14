import { getErrorMessage } from '@kody-internal/shared/error-message.ts'
import {
	CloudflareCustomHostnamesClient,
	isCloudflareCustomHostnameGone,
	type CloudflareCustomHostnameResult,
} from '#worker/package-app-custom-hostnames/cloudflare-custom-hostnames-client.ts'
import { invalidateCachedPackageAppCustomHostname } from '#worker/package-app-custom-hostnames/lookup-cache.ts'
import { isPackageAppCustomHostnameVerified } from '#worker/package-app-custom-hostnames/lookup.ts'
import {
	listPackageAppCustomHostnamesForReconcile,
	removePackageAppCustomHostnameRow,
} from '#worker/package-app-custom-hostnames/service.ts'
import { type PackageAppCustomHostnameRow } from '#worker/package-app-custom-hostnames/types.ts'

export const packageAppCustomHostnameGracePeriodMs = 36 * 60 * 60 * 1000

export type ReconcilePackageAppCustomHostnamesResult = {
	scanned: number
	updated: number
	removed: number
	skipped: number
	errors: number
	budgetExhausted: boolean
}

const defaultBatchSize = 50
export const reconcilePackageAppCustomHostnamesBudgetMs = 60_000

function createClient(env: Env & { fetcher?: Fetcher }) {
	if (
		!env.CLOUDFLARE_CUSTOM_HOSTNAMES_API_TOKEN?.trim() ||
		!env.PACKAGE_APP_ZONE_ID?.trim()
	) {
		return null
	}
	return new CloudflareCustomHostnamesClient({
		CLOUDFLARE_CUSTOM_HOSTNAMES_API_TOKEN:
			env.CLOUDFLARE_CUSTOM_HOSTNAMES_API_TOKEN,
		PACKAGE_APP_ZONE_ID: env.PACKAGE_APP_ZONE_ID,
		fetcher: env.fetcher,
	})
}

function shouldStartDnsMissingGrace(input: {
	verifiedAt: string | null
	hostnameStatus: string
	sslStatus: string
}) {
	if (
		isPackageAppCustomHostnameVerified({
			hostnameStatus: input.hostnameStatus,
			sslStatus: input.sslStatus,
		})
	) {
		return false
	}
	if (input.verifiedAt) return true
	return input.hostnameStatus === 'moved' || input.hostnameStatus === 'deleted'
}

function deletedCloudflareHostnameResult(
	row: PackageAppCustomHostnameRow,
): CloudflareCustomHostnameResult {
	return {
		id: row.cloudflareHostnameId ?? row.id,
		hostname: row.hostname,
		hostnameStatus: 'deleted',
		sslStatus: row.sslStatus,
		ownershipVerification: null,
		sslValidationRecords: [],
	}
}

export async function reconcilePackageAppCustomHostnames(input: {
	env: Env
	now?: Date
	batchSize?: number
	timeBudgetMs?: number
}): Promise<ReconcilePackageAppCustomHostnamesResult> {
	const now = input.now ?? new Date()
	const nowIso = now.toISOString()
	const deadline =
		Date.now() +
		(input.timeBudgetMs ?? reconcilePackageAppCustomHostnamesBudgetMs)
	const client = createClient(input.env)
	const result: ReconcilePackageAppCustomHostnamesResult = {
		scanned: 0,
		updated: 0,
		removed: 0,
		skipped: 0,
		errors: 0,
		budgetExhausted: false,
	}
	if (!client) {
		return result
	}

	let afterId = ''
	while (Date.now() < deadline) {
		const batch = await listPackageAppCustomHostnamesForReconcile(
			input.env.APP_DB,
			{
				limit: input.batchSize ?? defaultBatchSize,
				afterId,
			},
		)
		if (batch.length === 0) break
		afterId = batch[batch.length - 1]!.id

		for (const row of batch) {
			if (Date.now() >= deadline) {
				result.budgetExhausted = true
				break
			}
			result.scanned += 1
			const cfId = row.cloudflareHostnameId?.trim()
			if (!cfId) {
				result.skipped += 1
				continue
			}
			try {
				const cfOrGone = await client.getCustomHostname({ id: cfId })
				const cf = isCloudflareCustomHostnameGone(cfOrGone)
					? deletedCloudflareHostnameResult(row)
					: cfOrGone
				const verified = isPackageAppCustomHostnameVerified({
					hostnameStatus: cf.hostnameStatus,
					sslStatus: cf.sslStatus ?? row.sslStatus,
				})
				let dnsMissingSince = row.dnsMissingSince
				if (verified) {
					dnsMissingSince = null
				} else if (
					shouldStartDnsMissingGrace({
						verifiedAt: row.verifiedAt,
						hostnameStatus: cf.hostnameStatus,
						sslStatus: cf.sslStatus ?? row.sslStatus,
					})
				) {
					dnsMissingSince = dnsMissingSince ?? nowIso
				}
				const verifiedAt = verified && !row.verifiedAt ? nowIso : row.verifiedAt
				if (
					dnsMissingSince &&
					now.getTime() - Date.parse(dnsMissingSince) >=
						packageAppCustomHostnameGracePeriodMs
				) {
					await removePackageAppCustomHostnameRow({
						env: input.env,
						row,
					})
					result.removed += 1
					continue
				}
				await input.env.APP_DB.prepare(
					`UPDATE package_app_custom_hostnames
						 SET hostname_status = ?,
						     ssl_status = ?,
						     verified_at = ?,
						     dns_missing_since = ?,
						     updated_at = ?
						 WHERE id = ?`,
				)
					.bind(
						cf.hostnameStatus,
						cf.sslStatus ?? row.sslStatus,
						verifiedAt,
						dnsMissingSince,
						nowIso,
						row.id,
					)
					.run()
				invalidateCachedPackageAppCustomHostname(input.env.APP_DB, row.hostname)
				result.updated += 1
			} catch (error) {
				console.error(
					'package_app_custom_hostnames reconcile failed:',
					row.hostname,
					getErrorMessage(error),
				)
				result.errors += 1
			}
		}
		if (batch.length < (input.batchSize ?? defaultBatchSize)) break
	}
	return result
}
