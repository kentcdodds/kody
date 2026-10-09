/**
 * After a seat-affecting membership write, sync Stripe quantity and email
 * Owners/Billing. Call from access MCP paths that add, remove, or change
 * membership roles (owner/member seats vs billing-only).
 */
import { syncOrgSeatQuantity } from '#worker/billing/seat-sync.ts'

export async function syncSeatsAfterMembershipChange(input: {
	db: D1Database
	env: Env
	orgId: string
}): Promise<void> {
	try {
		await syncOrgSeatQuantity({
			db: input.db,
			env: input.env,
			orgId: input.orgId,
			emailEnv: input.env,
			notifySeatChange: true,
		})
	} catch (error) {
		console.warn('org-seat-sync-after-membership-failed', {
			orgId: input.orgId,
			error,
		})
	}
}
