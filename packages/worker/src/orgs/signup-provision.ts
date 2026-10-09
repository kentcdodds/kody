import {
	deletePersonalOrgForRollback,
	provisionPersonalOrg,
	type ProvisionPersonalOrgInput,
} from './provision.ts'

export async function provisionPersonalOrgForSignup(
	db: D1Database,
	input: ProvisionPersonalOrgInput,
) {
	await provisionPersonalOrg(db, input)
}

export async function rollbackPersonalOrgAfterFailedSignup(
	db: D1Database,
	stableUserId: string,
) {
	await deletePersonalOrgForRollback(db, stableUserId)
}
