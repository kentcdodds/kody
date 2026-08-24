import { utcDayKey, utcMonthKey } from '@kody-internal/shared/date-keys.ts'
import { sendCloudflareEmail } from '#app/email/cloudflare-email.ts'
import {
	buildUserEntitlementWarningEmail,
	type UserEntitlementWarningKind,
} from '#app/email/messages.ts'
import { resolveTransactionalEmailConfig } from '#app/email/sender-config.ts'
import { readAdminEntitlementConsumption } from '#worker/admin/entitlement-consumption.ts'
import {
	parseStoredPlanName,
	planLimits,
	resolveEffectivePlan,
} from '#universal/plans.ts'

/**
 * Hourly user-facing entitlement warnings. Shares the
 * `usage_entitlement_alert` lane with the operator fleet-pressure mail so
 * both stay on the same UTC-hour cadence. Failures here must not block
 * the operator alert.
 *
 * Throttle is one approaching (80%) email and one reached (100%) email per
 * verified person per UTC day, listing every resource currently in that
 * bucket. It is not per-resource.
 */

export const userEntitlementWarningKvKeyPrefix = 'entitlement-warning-user:v2'
export const userEntitlementWarningSweepLimit = 100
export const userEntitlementWarningActiveSweepLimit = 80
export const userEntitlementWarningStockSweepLimit = 40
export const userEntitlementWarningDailyTtlSeconds = 36 * 60 * 60
export const userEntitlementApproachingThreshold = 0.8
export const userEntitlementReachedThreshold = 1
const warningSweepConcurrency = 4

const stockPackageThreshold = Math.ceil(planLimits.free.maxSavedPackages * 0.8)
const stockSecretThreshold = Math.ceil(planLimits.free.maxSecrets * 0.8)

type WarningCandidate = {
	stable_user_id: string
	email: string
	plan: string
	stripe_plan: string | null
}

type WarningResource = {
	label: string
	current: number
	limit: number
	percentOfLimit: number
}

export type UserEntitlementWarningEmailResult =
	| { status: 'skipped'; reason: 'no_kv' | 'no_email_config' }
	| { status: 'no_warnings' }
	| {
			status: 'notified'
			emailedUsers: number
			emailsSent: number
			warnedResources: number
	  }

export function userEntitlementWarningKvKey(input: {
	userId: string
	kind: UserEntitlementWarningKind
	day: string
}) {
	return `${userEntitlementWarningKvKeyPrefix}:${input.userId}:${input.kind}:${input.day}`
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
	let emailsSent = 0
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
			emailsSent += sent.emailsSent
			warnedResources += sent.warnedResources
		},
	)

	if (emailedUsers === 0) return { status: 'no_warnings' }
	console.info('user-entitlement-warning-emailed', {
		emailedUsers,
		emailsSent,
		warnedResources,
	})
	return { status: 'notified', emailedUsers, emailsSent, warnedResources }
}

async function warnOneUserIfNeeded(input: {
	env: Env
	emailConfig: { appBaseUrl: string; fromEmail: string }
	user: WarningCandidate
	now: Date
}): Promise<{ emailsSent: number; warnedResources: number } | null> {
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
	const approaching: Array<WarningResource> = []
	const reached: Array<WarningResource> = []
	for (const item of consumption) {
		if (item.percentOfLimit == null) continue
		const warning = {
			label: item.label,
			current: item.current,
			limit: item.limit,
			percentOfLimit: item.percentOfLimit,
		}
		if (item.percentOfLimit >= userEntitlementReachedThreshold) {
			reached.push(warning)
			continue
		}
		if (item.percentOfLimit >= userEntitlementApproachingThreshold) {
			approaching.push(warning)
		}
	}
	if (approaching.length === 0 && reached.length === 0) return null

	const day = utcDayKey(input.now)
	let emailsSent = 0
	let warnedResources = 0
	// Reached first so a same-hour jump to 100% sends the limit mail
	// even when an 80% send is also due.
	for (const [kind, warnings] of [
		['reached', reached],
		['approaching', approaching],
	] as const) {
		const sent = await sendThresholdEmailIfNeeded({
			env: input.env,
			kv,
			emailConfig: input.emailConfig,
			user: input.user,
			kind,
			warnings,
			day,
			now: input.now,
		})
		if (!sent) continue
		emailsSent += 1
		warnedResources += warnings.length
	}
	if (emailsSent === 0) return null
	return { emailsSent, warnedResources }
}

async function sendThresholdEmailIfNeeded(input: {
	env: Env
	kv: KVNamespace
	emailConfig: { appBaseUrl: string; fromEmail: string }
	user: WarningCandidate
	kind: UserEntitlementWarningKind
	warnings: Array<WarningResource>
	day: string
	now: Date
}): Promise<boolean> {
	if (input.warnings.length === 0) return false
	const key = userEntitlementWarningKvKey({
		userId: input.user.stable_user_id,
		kind: input.kind,
		day: input.day,
	})
	if (await input.kv.get(key)) return false

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
		kind: input.kind,
		warnings: input.warnings,
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
		return false
	}
	if (!sendResult.ok) {
		console.warn('user-entitlement-warning-send-skipped', {
			reason: sendResult.error ?? 'unconfigured',
		})
		return false
	}

	await input.kv.put(key, String(input.now.getTime()), {
		expirationTtl: userEntitlementWarningDailyTtlSeconds,
	})
	return true
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
