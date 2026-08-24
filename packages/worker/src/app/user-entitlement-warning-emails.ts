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
	type EntitlementResource,
} from '#universal/plans.ts'

/**
 * Hourly user-facing entitlement warnings. Shares the
 * `usage_entitlement_alert` lane with the operator fleet-pressure mail so
 * both stay on the same UTC-hour cadence. Failures here must not block
 * the operator alert.
 *
 * One email per crossing of 80% or 100% on a specific entitlement. Staying
 * over the same threshold does not mail again. A later drop below that
 * threshold, then a climb back over it, is a new instance. Same-hour
 * crossings of the same kind still batch into one mail. Stock claims expire
 * after 30 days unless an hourly sweep still sees the user over and refreshes
 * the TTL; daily `*_per_day` claims stay scoped to the UTC day.
 */

export const userEntitlementWarningKvKeyPrefix = 'entitlement-warning-user:v3'
export const userEntitlementWarningDailyKvKeyPrefix =
	'entitlement-warning-user:v2'
export const userEntitlementWarningSweepLimit = 100
export const userEntitlementWarningActiveSweepLimit = 80
export const userEntitlementWarningStockSweepLimit = 40
export const userEntitlementApproachingThreshold = 0.8
export const userEntitlementReachedThreshold = 1
const warningSweepConcurrency = 4
const dailyClaimLookbackDays = 3
export const userEntitlementWarningDailyClaimTtlSeconds = 36 * 60 * 60
export const userEntitlementWarningStockClaimTtlSeconds = 30 * 24 * 60 * 60

const stockPackageThreshold = Math.ceil(planLimits.free.maxSavedPackages * 0.8)
const stockSecretThreshold = Math.ceil(planLimits.free.maxSecrets * 0.8)

type WarningCandidate = {
	stable_user_id: string
	email: string
	plan: string
	stripe_plan: string | null
}

type WarningResource = {
	resource: EntitlementResource
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

export function isDailyEntitlementResource(resource: EntitlementResource) {
	return resource.endsWith('_per_day')
}

export function userEntitlementWarningKvKey(input: {
	userId: string
	kind: UserEntitlementWarningKind
	resource: EntitlementResource
	day?: string
}) {
	const base = `${userEntitlementWarningKvKeyPrefix}:${input.userId}:${input.kind}:${input.resource}`
	if (!isDailyEntitlementResource(input.resource)) return base
	if (!input.day) {
		throw new Error(
			`Daily entitlement warning key for ${input.resource} requires a UTC day`,
		)
	}
	return `${base}:${input.day}`
}

export function userEntitlementWarningDailyKvKey(input: {
	userId: string
	kind: UserEntitlementWarningKind
	day: string
}) {
	return `${userEntitlementWarningDailyKvKeyPrefix}:${input.userId}:${input.kind}:${input.day}`
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
			resource: item.resource,
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
			await deleteWarningClaims({
				kv,
				userId: input.user.stable_user_id,
				kind: 'reached',
				resource: item.resource,
				now: input.now,
			})
			continue
		}
		await Promise.all([
			deleteWarningClaims({
				kv,
				userId: input.user.stable_user_id,
				kind: 'approaching',
				resource: item.resource,
				now: input.now,
			}),
			deleteWarningClaims({
				kv,
				userId: input.user.stable_user_id,
				kind: 'reached',
				resource: item.resource,
				now: input.now,
			}),
		])
	}

	await absorbDailyClaims({
		kv,
		userId: input.user.stable_user_id,
		kind: 'reached',
		warnings: reached,
		now: input.now,
	})
	await absorbDailyClaims({
		kv,
		userId: input.user.stable_user_id,
		kind: 'approaching',
		warnings: approaching,
		now: input.now,
	})

	const newReached = await unclaimedWarnings({
		kv,
		userId: input.user.stable_user_id,
		kind: 'reached',
		warnings: reached,
		now: input.now,
	})
	const newApproaching = await unclaimedWarnings({
		kv,
		userId: input.user.stable_user_id,
		kind: 'approaching',
		warnings: approaching,
		now: input.now,
	})
	await refreshStillOverStockClaims({
		kv,
		userId: input.user.stable_user_id,
		now: input.now,
		reached,
		approaching,
		newReached,
		newApproaching,
	})
	if (newApproaching.length === 0 && newReached.length === 0) return null

	let emailsSent = 0
	let warnedResources = 0
	// Reached first so a same-hour jump to 100% sends the limit mail
	// even when an 80% send is also due.
	for (const [kind, warnings] of [
		['reached', newReached],
		['approaching', newApproaching],
	] as const) {
		const sent = await sendThresholdEmailIfNeeded({
			env: input.env,
			kv,
			emailConfig: input.emailConfig,
			user: input.user,
			kind,
			warnings,
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
	now: Date
}): Promise<boolean> {
	if (input.warnings.length === 0) return false

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

	await claimWarningInstance({
		kv: input.kv,
		userId: input.user.stable_user_id,
		kind: input.kind,
		warnings: input.warnings,
		now: input.now,
	})
	return true
}

async function absorbDailyClaims(input: {
	kv: KVNamespace
	userId: string
	kind: UserEntitlementWarningKind
	warnings: Array<WarningResource>
	now: Date
}) {
	if (input.warnings.length === 0) return
	const today = utcDayKey(input.now)
	const todayClaimed = await input.kv.get(
		userEntitlementWarningDailyKvKey({
			userId: input.userId,
			kind: input.kind,
			day: today,
		}),
	)
	if (todayClaimed) {
		await claimWarningInstance({
			kv: input.kv,
			userId: input.userId,
			kind: input.kind,
			warnings: input.warnings,
			now: input.now,
		})
		return
	}

	let priorDayClaimed = false
	for (const day of recentUtcDayKeys(input.now)) {
		if (day === today) continue
		const dailyKey = userEntitlementWarningDailyKvKey({
			userId: input.userId,
			kind: input.kind,
			day,
		})
		if (await input.kv.get(dailyKey)) {
			priorDayClaimed = true
			break
		}
	}
	if (!priorDayClaimed) return

	const stockWarnings = input.warnings.filter(
		(warning) => !isDailyEntitlementResource(warning.resource),
	)
	if (stockWarnings.length === 0) return
	await claimWarningInstance({
		kv: input.kv,
		userId: input.userId,
		kind: input.kind,
		warnings: stockWarnings,
		now: input.now,
	})
}

async function unclaimedWarnings(input: {
	kv: KVNamespace
	userId: string
	kind: UserEntitlementWarningKind
	warnings: Array<WarningResource>
	now: Date
}) {
	const next: Array<WarningResource> = []
	for (const warning of input.warnings) {
		const claimed = await input.kv.get(
			warningInstanceKey({
				userId: input.userId,
				kind: input.kind,
				resource: warning.resource,
				now: input.now,
			}),
		)
		if (claimed) continue
		next.push(warning)
	}
	return next
}

async function claimWarningInstance(input: {
	kv: KVNamespace
	userId: string
	kind: UserEntitlementWarningKind
	warnings: Array<WarningResource>
	now: Date
}) {
	const claimedAt = String(input.now.getTime())
	for (const warning of input.warnings) {
		await putWarningClaim({
			kv: input.kv,
			userId: input.userId,
			kind: input.kind,
			resource: warning.resource,
			now: input.now,
			claimedAt,
		})
		if (input.kind !== 'reached') continue
		// Same climb already passed 80%. Claiming approaching here keeps a
		// later drop into the 80–99% band from sending a second mail.
		await putWarningClaim({
			kv: input.kv,
			userId: input.userId,
			kind: 'approaching',
			resource: warning.resource,
			now: input.now,
			claimedAt,
		})
	}
}

async function refreshStillOverStockClaims(input: {
	kv: KVNamespace
	userId: string
	now: Date
	reached: Array<WarningResource>
	approaching: Array<WarningResource>
	newReached: Array<WarningResource>
	newApproaching: Array<WarningResource>
}) {
	const claimedAt = String(input.now.getTime())
	const newReachedResources = new Set(
		input.newReached.map((warning) => warning.resource),
	)
	const newApproachingResources = new Set(
		input.newApproaching.map((warning) => warning.resource),
	)
	for (const warning of input.reached) {
		if (isDailyEntitlementResource(warning.resource)) continue
		if (newReachedResources.has(warning.resource)) continue
		await putWarningClaim({
			kv: input.kv,
			userId: input.userId,
			kind: 'reached',
			resource: warning.resource,
			now: input.now,
			claimedAt,
		})
		// Keep the paired approaching claim alive so sitting at a cap does
		// not let the 80% claim expire and rematch on a later drop to 80–99%.
		if (newApproachingResources.has(warning.resource)) continue
		await putWarningClaim({
			kv: input.kv,
			userId: input.userId,
			kind: 'approaching',
			resource: warning.resource,
			now: input.now,
			claimedAt,
		})
	}
	for (const warning of input.approaching) {
		if (isDailyEntitlementResource(warning.resource)) continue
		if (newApproachingResources.has(warning.resource)) continue
		await putWarningClaim({
			kv: input.kv,
			userId: input.userId,
			kind: 'approaching',
			resource: warning.resource,
			now: input.now,
			claimedAt,
		})
	}
}

function warningInstanceKey(input: {
	userId: string
	kind: UserEntitlementWarningKind
	resource: EntitlementResource
	now: Date
}) {
	return userEntitlementWarningKvKey({
		userId: input.userId,
		kind: input.kind,
		resource: input.resource,
		day: isDailyEntitlementResource(input.resource)
			? utcDayKey(input.now)
			: undefined,
	})
}

async function putWarningClaim(input: {
	kv: KVNamespace
	userId: string
	kind: UserEntitlementWarningKind
	resource: EntitlementResource
	now: Date
	claimedAt: string
}) {
	const key = warningInstanceKey(input)
	const expirationTtl = isDailyEntitlementResource(input.resource)
		? userEntitlementWarningDailyClaimTtlSeconds
		: userEntitlementWarningStockClaimTtlSeconds
	try {
		await input.kv.put(key, input.claimedAt, { expirationTtl })
	} catch (error) {
		console.warn('user-entitlement-warning-claim-failed', {
			kind: input.kind,
			resource: input.resource,
			error,
		})
	}
}

async function deleteWarningClaims(input: {
	kv: KVNamespace
	userId: string
	kind: UserEntitlementWarningKind
	resource: EntitlementResource
	now: Date
}) {
	if (!isDailyEntitlementResource(input.resource)) {
		await input.kv.delete(
			userEntitlementWarningKvKey({
				userId: input.userId,
				kind: input.kind,
				resource: input.resource,
			}),
		)
		return
	}
	await Promise.all(
		recentUtcDayKeys(input.now).map((day) =>
			input.kv.delete(
				userEntitlementWarningKvKey({
					userId: input.userId,
					kind: input.kind,
					resource: input.resource,
					day,
				}),
			),
		),
	)
}

function recentUtcDayKeys(now: Date) {
	const keys: Array<string> = []
	for (let daysAgo = 0; daysAgo < dailyClaimLookbackDays; daysAgo += 1) {
		keys.push(
			utcDayKey(new Date(now.getTime() - daysAgo * 24 * 60 * 60 * 1000)),
		)
	}
	return keys
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
