import { normalizeUsername } from '#worker/identity/username.ts'
import { andLiveDeletedAtSql } from '#worker/soft-delete/live-sql.ts'

export type ProvisionPersonalOrgInput = {
	stableUserId: string
	username: string
	createdAt?: string
	displayName?: string | null
	bio?: string | null
	avatarKey?: string | null
	profileVisibility?: 'public' | 'private' | null
	plan?: string | null
	entitlementLadder?: string | null
	stripeCustomerId?: string | null
	stripePlan?: string | null
	stripePriceId?: string | null
	stripePlanRefreshedAt?: string | null
	stripeCreditsEligible?: number | null
	adminCreditsEligible?: number | null
	secondAgentStandardGiftGrantedAt?: string | null
	secondAgentStandardGiftExpiresAt?: string | null
	referralStandardCreditExpiresAt?: string | null
	signupWelcomeCreditsPending?: number | null
}

function orgSlugFromUsername(username: string) {
	const normalized = normalizeUsername(username)
	if (!normalized) {
		throw new Error('Cannot provision personal org without a username.')
	}
	return normalized.toLowerCase()
}

/** Same logical batch as D1 `batch()`; sequential runs for test mocks without `.batch`. */
async function runProvisionStatements(
	statements: Array<{ run(): Promise<unknown> }>,
) {
	for (const statement of statements) {
		await statement.run()
	}
}

/** Idempotent personal org provisioning for seeds and fixture re-runs. */
export async function ensurePersonalOrg(
	db: D1Database,
	input: ProvisionPersonalOrgInput,
) {
	const existing = await db
		.prepare(`SELECT id FROM orgs WHERE id = ?${andLiveDeletedAtSql()}`)
		.bind(input.stableUserId)
		.first<{ id: string }>()
	if (existing) return
	await provisionPersonalOrg(db, input)
}

/**
 * Insert the personal org row, owner membership, and live handle for a new
 * account. Uses plain INSERT so unique conflicts fail loudly.
 */
export async function provisionPersonalOrg(
	db: D1Database,
	input: ProvisionPersonalOrgInput,
) {
	const createdAt = input.createdAt ?? new Date().toISOString()
	const slug = orgSlugFromUsername(input.username)
	const handle = slug
	const plan = input.plan?.trim() || 'free'
	const entitlementLadder = input.entitlementLadder?.trim() || 'public'
	const profileVisibility = input.profileVisibility ?? 'public'
	const stripeCreditsEligible =
		Number(input.stripeCreditsEligible) === 1 ? 1 : 0
	const adminCreditsEligible = Number(input.adminCreditsEligible) === 1 ? 1 : 0
	const signupWelcomeCreditsPending =
		Number(input.signupWelcomeCreditsPending) === 1 ? 1 : 0

	await runProvisionStatements([
		db
			.prepare(
				`INSERT INTO orgs (
					id,
					slug,
					display_name,
					bio,
					avatar_key,
					profile_visibility,
					plan,
					entitlement_ladder,
					stripe_customer_id,
					stripe_plan,
					stripe_price_id,
					stripe_plan_refreshed_at,
					stripe_credits_eligible,
					admin_credits_eligible,
					second_agent_standard_gift_granted_at,
					second_agent_standard_gift_expires_at,
					referral_standard_credit_expires_at,
					signup_welcome_credits_pending,
					created_by_user_id,
					created_at,
					updated_at
				) VALUES (
					?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
				)`,
			)
			.bind(
				input.stableUserId,
				slug,
				input.displayName ?? null,
				input.bio ?? null,
				input.avatarKey ?? null,
				profileVisibility,
				plan,
				entitlementLadder,
				input.stripeCustomerId ?? null,
				input.stripePlan ?? null,
				input.stripePriceId ?? null,
				input.stripePlanRefreshedAt ?? null,
				stripeCreditsEligible,
				adminCreditsEligible,
				input.secondAgentStandardGiftGrantedAt ?? null,
				input.secondAgentStandardGiftExpiresAt ?? null,
				input.referralStandardCreditExpiresAt ?? null,
				signupWelcomeCreditsPending,
				input.stableUserId,
				createdAt,
				createdAt,
			),
		db
			.prepare(
				`INSERT INTO org_memberships (
					org_id, user_id, role, invited_by_user_id, created_at, deleted_at
				) VALUES (?, ?, 'owner', NULL, ?, NULL)`,
			)
			.bind(input.stableUserId, input.stableUserId, createdAt),
		db
			.prepare(
				`INSERT INTO handles (handle, user_id, org_id, created_at)
				 VALUES (?, ?, ?, ?)`,
			)
			.bind(handle, input.stableUserId, input.stableUserId, createdAt),
	])
}

/** Best-effort cleanup when account creation rolls back after user insert. */
export async function deletePersonalOrgForRollback(
	db: D1Database,
	stableUserId: string,
) {
	try {
		await runProvisionStatements([
			db
				.prepare(
					`DELETE FROM org_memberships WHERE org_id = ?${andLiveDeletedAtSql()}`,
				)
				.bind(stableUserId),
			db
				.prepare(`DELETE FROM handles WHERE user_id = ? OR org_id = ?`)
				.bind(stableUserId, stableUserId),
			db
				.prepare(`DELETE FROM orgs WHERE id = ?${andLiveDeletedAtSql()}`)
				.bind(stableUserId),
		])
	} catch (error) {
		console.error('Failed to roll back personal org rows:', error)
	}
}
