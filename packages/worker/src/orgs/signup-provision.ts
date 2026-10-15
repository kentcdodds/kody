import {
	deletePersonalOrgForRollback,
	mintPersonalOrgIdForSignup,
	provisionPersonalOrg,
	type ProvisionPersonalOrgInput,
} from './provision.ts'

/**
 * Provision the personal org for a new signup. Requires `orgId` (mint with
 * {@link mintPersonalOrgIdForSignup}) so `orgs.id` is distinct from the person
 * id. Returns the org id used.
 */
export async function provisionPersonalOrgForSignup(
	db: D1Database,
	input: ProvisionPersonalOrgInput,
) {
	const orgId = input.orgId?.trim() || mintPersonalOrgIdForSignup()
	await provisionPersonalOrg(db, { ...input, orgId })
	return orgId
}

export async function rollbackPersonalOrgAfterFailedSignup(
	db: D1Database,
	stableUserId: string,
	orgId?: string,
) {
	await deletePersonalOrgForRollback(db, stableUserId, orgId)
}

export { mintPersonalOrgIdForSignup }
