import { getErrorMessage } from '@kody-internal/shared/error-message.ts'
import { CloudflareCustomHostnamesClient } from '#worker/package-app-custom-hostnames/cloudflare-custom-hostnames-client.ts'
import { isPackageAppCustomHostnameVerified } from '#worker/package-app-custom-hostnames/lookup.ts'
import {
	listPackageAppCustomHostnamesForReconcile,
	removePackageAppCustomHostnameRow,
} from '#worker/package-app-custom-hostnames/service.ts'

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

	let afterUpdatedAt = ''
	while (Date.now() < deadline) {
		const batch = await listPackageAppCustomHostnamesForReconcile(
			input.env.APP_DB,
			{
				limit: input.batchSize ?? defaultBatchSize,
				afterUpdatedAt,
			},
		)
		if (batch.length === 0) break
		afterUpdatedAt = batch[batch.length - 1]!.updatedAt

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
				const cf = await client.getCustomHostname({ id: cfId })
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
