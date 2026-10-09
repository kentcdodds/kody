/** Teams P6 org billing helpers (seats, free-org cap, budgets). */
import { andLiveDeletedAtSql } from '#worker/soft-delete/live-sql.ts'

// After P5 membership mutations land, call syncOrgSeatQuantity from
// packages/worker/src/billing/seat-sync.ts (cleanup issue tracks wiring).

export const MAX_FREE_ORGS_PER_USER = 2

export const SEAT_ROLES = ['owner', 'member'] as const

export type OrgSeatRole = (typeof SEAT_ROLES)[number]

export function isPaidOrg(plan: string): boolean {
	return plan !== 'free'
}

/** Stripe customer for org-scoped checkout (team org row, else personal user). */
export async function readOrgStripeCustomerId(
	db: D1Database,
	orgId: string,
): Promise<string | null> {
	const org = await db
		.prepare(
			`SELECT stripe_customer_id FROM orgs WHERE id = ? AND deleted_at IS NULL`,
		)
		.bind(orgId)
		.first<{ stripe_customer_id: string | null }>()
	const orgCustomer = org?.stripe_customer_id?.trim()
	if (orgCustomer) return orgCustomer
	const user = await db
		.prepare(
			`SELECT stripe_customer_id FROM users WHERE stable_user_id = ?${andLiveDeletedAtSql()}`,
		)
		.bind(orgId)
		.first<{ stripe_customer_id: string | null }>()
	return user?.stripe_customer_id?.trim() || null
}

export class FreeOrgLimitError extends Error {
	override name = 'FreeOrgLimitError'

	constructor(message: string) {
		super(message)
	}
}

const FREE_ORG_LIMIT_MESSAGE =
	'You already own 2 free organizations. Make one paid or delete one before creating or accepting ownership of another free org.'

/**
 * Count live owner/member memberships (seats). Billing-only and deleted rows
 * are excluded.
 */
export async function countLiveSeats(
	db: D1Database,
	orgId: string,
): Promise<number> {
	const row = await db
		.prepare(
			`SELECT COUNT(*) AS count
			 FROM org_memberships
			 WHERE org_id = ?
			   AND role IN ('owner', 'member')
			   AND deleted_at IS NULL`,
		)
		.bind(orgId)
		.first<{ count: number }>()
	return row?.count ?? 0
}

/** User ids for live owners and billing-role members (invoice recipients). */
export async function listOrgBillingRecipientUserIds(
	db: D1Database,
	orgId: string,
): Promise<Array<string>> {
	const { results } = await db
		.prepare(
			`SELECT user_id
			 FROM org_memberships
			 WHERE org_id = ?
			   AND role IN ('owner', 'billing')
			   AND deleted_at IS NULL`,
		)
		.bind(orgId)
		.all<{ user_id: string }>()
	return results.map((row) => row.user_id)
}

/** Free orgs this user owns (live owner membership, org not deleted). */
export async function countLiveFreeOwnedOrgs(
	db: D1Database,
	userId: string,
): Promise<number> {
	const row = await db
		.prepare(
			`SELECT COUNT(*) AS count
			 FROM orgs o
			 INNER JOIN org_memberships m
			   ON m.org_id = o.id
			  AND m.user_id = ?
			  AND m.role = 'owner'
			  AND m.deleted_at IS NULL
			 WHERE o.plan = 'free'
			   AND o.deleted_at IS NULL`,
		)
		.bind(userId)
		.first<{ count: number }>()
	return row?.count ?? 0
}

export async function assertCanOwnAnotherFreeOrg(
	db: D1Database,
	userId: string,
): Promise<void> {
	const count = await countLiveFreeOwnedOrgs(db, userId)
	if (count >= MAX_FREE_ORGS_PER_USER) {
		throw new FreeOrgLimitError(FREE_ORG_LIMIT_MESSAGE)
	}
}

/**
 * Before granting live Owner on a free org, enforce the two-free-org cap.
 * Skips when the org is paid or the user already owns it.
 */
export async function assertCanAcceptFreeOrgOwnership(input: {
	db: D1Database
	orgId: string
	userId: string
}): Promise<void> {
	const org = await input.db
		.prepare(`SELECT plan FROM orgs WHERE id = ? AND deleted_at IS NULL`)
		.bind(input.orgId)
		.first<{ plan: string }>()
	if (!org || isPaidOrg(org.plan)) {
		return
	}
	const existingOwner = await input.db
		.prepare(
			`SELECT 1 AS ok FROM org_memberships
			 WHERE org_id = ? AND user_id = ? AND role = 'owner' AND deleted_at IS NULL`,
		)
		.bind(input.orgId, input.userId)
		.first<{ ok: number }>()
	if (existingOwner) {
		return
	}
	await assertCanOwnAnotherFreeOrg(input.db, input.userId)
}

export function resolveEffectiveUserBudgetMicroUsd(input: {
	individualBudget: number | null | undefined
	orgDefaultBudget: number | null | undefined
}): number | null {
	if (input.individualBudget != null) {
		return input.individualBudget
	}
	if (input.orgDefaultBudget != null) {
		return input.orgDefaultBudget
	}
	return null
}

export async function readOrgBudgetSettings(
	db: D1Database,
	orgId: string,
): Promise<{
	defaultUserBudgetMicroUsd: number | null
	automationBudgetMicroUsd: number | null
}> {
	const row = await db
		.prepare(
			`SELECT default_user_budget_micro_usd, automation_budget_micro_usd
			 FROM orgs
			 WHERE id = ?${andLiveDeletedAtSql()}`,
		)
		.bind(orgId)
		.first<{
			default_user_budget_micro_usd: number | null
			automation_budget_micro_usd: number | null
		}>()
	return {
		defaultUserBudgetMicroUsd: row?.default_user_budget_micro_usd ?? null,
		automationBudgetMicroUsd: row?.automation_budget_micro_usd ?? null,
	}
}

export async function readUserBudgetMicroUsd(
	db: D1Database,
	orgId: string,
	userId: string,
): Promise<number | null> {
	const row = await db
		.prepare(
			`SELECT monthly_budget_micro_usd
			 FROM org_user_budgets
			 WHERE org_id = ?
			   AND user_id = ?
			   AND deleted_at IS NULL`,
		)
		.bind(orgId, userId)
		.first<{ monthly_budget_micro_usd: number }>()
	return row?.monthly_budget_micro_usd ?? null
}
