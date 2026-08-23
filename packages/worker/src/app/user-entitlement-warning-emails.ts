import { utcDayKey, utcMonthKey } from '@kody-internal/shared/date-keys.ts'
import { sendCloudflareEmail } from '#app/email/cloudflare-email.ts'
import { buildUserEntitlementWarningEmail } from '#app/email/messages.ts'
import { resolveTransactionalEmailConfig } from '#app/email/sender-config.ts'
import { readAdminEntitlementConsumption } from '#worker/admin/entitlement-consumption.ts'
import { entitlementResourceVisibility } from '#worker/entitlements/resource-visibility.ts'
import {
	parseStoredPlanName,
	planLimits,
	resolveEffectivePlan,
	type EntitlementResource,
} from '#universal/plans.ts'

/**
 * Hourly user-facing 80% entitlement warnings. Shares the
 * `usage_entitlement_alert` lane with the operator fleet-pressure mail so
 * both stay on the same UTC-hour cadence. Failures here must not block
 * the operator alert.
 */

export const userEntitlementWarningKvKeyPrefix = 'entitlement-warning-user:v1'
export const userEntitlementWarningSweepLimit = 100
export const userEntitlementWarningActiveSweepLimit = 80
export const userEntitlementWarningStockSweepLimit = 40
export const userEntitlementWarningDailyTtlSeconds = 36 * 60 * 60
export const userEntitlementWarningStockTtlSeconds = 7 * 24 * 60 * 60
const warningSweepConcurrency = 4

const stockPackageThreshold = Math.ceil(planLimits.free.maxSavedPackages * 0.8)
const stockSecretThreshold = Math.ceil(planLimits.free.maxSecrets * 0.8)

type WarningCandidate = {
	stable_user_id: string
	email: string
	plan: string
	stripe_plan: string | null
}

export type UserEntitlementWarningEmailResult =
	| { status: 'skipped'; reason: 'no_kv' | 'no_email_config' }
	| { status: 'no_warnings' }
	| { status: 'notified'; emailedUsers: number; warnedResources: number }

export function isDailyEntitlementWarningResource(resource: string) {
	return (
		resource in entitlementResourceVisibility &&
		entitlementResourceVisibility[resource as EntitlementResource].group ===
			'daily'
	)
}

export function userEntitlementWarningPeriodKey(resource: string, now: Date) {
	return isDailyEntitlementWarningResource(resource) ? utcDayKey(now) : 'stock'
}

export function userEntitlementWarningKvKey(input: {
	userId: string
	resource: string
	period: string
}) {
	return `${userEntitlementWarningKvKeyPrefix}:${input.userId}:${input.resource}:${input.period}`
}

export function userEntitlementWarningTtlSeconds(resource: string) {
	return isDailyEntitlementWarningResource(resource)
		? userEntitlementWarningDailyTtlSeconds
		: userEntitlementWarningStockTtlSeconds
}

export async function sendUserEntitlementWarningEmails(input: {
	env: Env
	now?: Date
}): Promise<UserEntitlementWarningEmailResult> {
	const now = input.now ?? new Date()
	if (!input.env.BUNDLE_ARTIFACTS_KV) {
		return { status: 'skipped', reason: 'no_kv' }
	}
	const emailConfig = resolveTransactionalEmailConfig({ env: input.env })
	if (!emailConfig) {
		return { status: 'skipped', reason: 'no_email_config' }
	}

	const candidates = await listUsersForEntitlementWarningSweep(
		input.env.APP_DB,
		now,
	)
	if (candidates.length === 0) return { status: 'no_warnings' }

	let emailedUsers = 0
	let warnedResources = 0
	await mapWithConcurrency(
		candidates,
		warningSweepConcurrency,
		async (user) => {
			const sent = await warnOneUserIfNeeded({
				env: input.env,
				emailConfig,
				user,
				now,
			})
			if (!sent) return
			emailedUsers += 1
			warnedResources += sent
		},
	)

	if (emailedUsers === 0) return { status: 'no_warnings' }
	console.info('user-entitlement-warning-emailed', {
		emailedUsers,
		warnedResources,
	})
	return { status: 'notified', emailedUsers, warnedResources }
}

async function warnOneUserIfNeeded(input: {
	env: Env
	emailConfig: { appBaseUrl: string; fromEmail: string }
	user: WarningCandidate
	now: Date
}): Promise<number | null> {
	const kv = input.env.BUNDLE_ARTIFACTS_KV
	if (!kv) return null

	const plan = resolveEffectivePlan(
		parseStoredPlanName(input.user.plan),
		input.user.stripe_plan,
	)
	const consumption = await readAdminEntitlementConsumption({
		env: input.env,
		usageUserId: input.user.stable_user_id,
		plan,
		now: input.now,
	})
	const overLimit = consumption.filter(
		(item) => item.overEightyPercent && item.percentOfLimit != null,
	)
	if (overLimit.length === 0) return null

	const newlyWarned = []
	for (const item of overLimit) {
		const period = userEntitlementWarningPeriodKey(item.resource, input.now)
		const key = userEntitlementWarningKvKey({
			userId: input.user.stable_user_id,
			resource: item.resource,
			period,
		})
		const alreadySent = await kv.get(key)
		if (alreadySent) continue
		newlyWarned.push(item)
	}
	if (newlyWarned.length === 0) return null

	const billingUrl = new URL(
		'/account/billing',
		input.emailConfig.appBaseUrl,
	).toString()
	const usageUrl = new URL(
		'/account/usage',
		input.emailConfig.appBaseUrl,
	).toString()
	const email = buildUserEntitlementWarningEmail({
		appBaseUrl: input.emailConfig.appBaseUrl,
		billingUrl,
		usageUrl,
		warnings: newlyWarned.map((item) => ({
			label: item.label,
			current: item.current,
			limit: item.limit,
			percentOfLimit: item.percentOfLimit ?? 0,
		})),
	})

	let sendResult: Awaited<ReturnType<typeof sendCloudflareEmail>>
	try {
		sendResult = await sendCloudflareEmail(
			{
				accountId: input.env.CLOUDFLARE_ACCOUNT_ID,
				apiBaseUrl: input.env.CLOUDFLARE_API_BASE_URL,
				apiToken: input.env.CLOUDFLARE_API_TOKEN,
			},
			{
				to: input.user.email,
				from: input.emailConfig.fromEmail,
				subject: email.subject,
				html: email.html,
				text: email.text,
			},
		)
	} catch (error) {
		console.warn('user-entitlement-warning-send-failed', error)
		return null
	}
	if (!sendResult.ok) {
		console.warn('user-entitlement-warning-send-skipped', {
			reason: sendResult.error ?? 'unconfigured',
		})
		return null
	}

	for (const item of newlyWarned) {
		const period = userEntitlementWarningPeriodKey(item.resource, input.now)
		await kv.put(
			userEntitlementWarningKvKey({
				userId: input.user.stable_user_id,
				resource: item.resource,
				period,
			}),
			String(input.now.getTime()),
			{ expirationTtl: userEntitlementWarningTtlSeconds(item.resource) },
		)
	}
	return newlyWarned.length
}

async function listUsersForEntitlementWarningSweep(db: D1Database, now: Date) {
	const currentMonth = utcMonthKey(now)
	const [active, packages, secrets] = await Promise.all([
		db
			.prepare(
				`SELECT u.stable_user_id, u.email, u.plan, u.stripe_plan
				 FROM (
					SELECT user_id, SUM(event_count) AS event_count
					FROM usage_rollups
					WHERE month = ?
					GROUP BY user_id
					ORDER BY event_count DESC
					LIMIT ?
				 ) AS ranked
				 INNER JOIN users u ON u.stable_user_id = ranked.user_id
				 WHERE u.deleting_at IS NULL
					AND u.account_type = 'person'
					AND u.email_verified_at IS NOT NULL
				 ORDER BY ranked.event_count DESC`,
			)
			.bind(currentMonth, userEntitlementWarningActiveSweepLimit)
			.all<WarningCandidate>(),
		db
			.prepare(
				`SELECT u.stable_user_id, u.email, u.plan, u.stripe_plan
				 FROM (
					SELECT user_id, COUNT(*) AS stock_count
					FROM saved_packages
					GROUP BY user_id
					HAVING COUNT(*) >= ?
					ORDER BY stock_count DESC
					LIMIT ?
				 ) AS stock
				 INNER JOIN users u ON u.stable_user_id = stock.user_id
				 WHERE u.deleting_at IS NULL
					AND u.account_type = 'person'
					AND u.email_verified_at IS NOT NULL`,
			)
			.bind(stockPackageThreshold, userEntitlementWarningStockSweepLimit)
			.all<WarningCandidate>(),
		db
			.prepare(
				`SELECT u.stable_user_id, u.email, u.plan, u.stripe_plan
				 FROM (
					SELECT sb.user_id, COUNT(*) AS stock_count
					FROM secret_entries se
					JOIN secret_buckets sb ON sb.id = se.bucket_id
					WHERE sb.expires_at IS NULL OR sb.expires_at > ?
					GROUP BY sb.user_id
					HAVING COUNT(*) >= ?
					ORDER BY stock_count DESC
					LIMIT ?
				 ) AS stock
				 INNER JOIN users u ON u.stable_user_id = stock.user_id
				 WHERE u.deleting_at IS NULL
					AND u.account_type = 'person'
					AND u.email_verified_at IS NOT NULL`,
			)
			.bind(
				now.toISOString(),
				stockSecretThreshold,
				userEntitlementWarningStockSweepLimit,
			)
			.all<WarningCandidate>(),
	])

	const byUserId = new Map<string, WarningCandidate>()
	for (const row of [
		...(active.results ?? []),
		...(packages.results ?? []),
		...(secrets.results ?? []),
	]) {
		if (byUserId.has(row.stable_user_id)) continue
		byUserId.set(row.stable_user_id, row)
		if (byUserId.size >= userEntitlementWarningSweepLimit) break
	}
	return [...byUserId.values()]
}

async function mapWithConcurrency<T>(
	items: ReadonlyArray<T>,
	concurrency: number,
	mapper: (item: T) => Promise<void>,
): Promise<void> {
	if (items.length === 0) return
	const limit = Math.max(1, Math.min(concurrency, items.length))
	let nextIndex = 0
	await Promise.all(
		Array.from({ length: limit }, async () => {
			while (nextIndex < items.length) {
				const index = nextIndex
				nextIndex += 1
				const item = items[index]
				if (item === undefined) return
				await mapper(item)
			}
		}),
	)
}
