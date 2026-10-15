// soft-delete-read-filter: opt-out
import { type OwnerId } from '@kody-internal/shared/owner-person-ids.ts'
import {
	buildUserScopedDeleteOrUpdateSql,
	buildUserScopedTargetMatch,
} from '#worker/account/data-targets.ts'
import {
	deleteUserAccount,
	purgeOwnerOutOfBandSurfaces,
} from '#app/account-deletion.ts'
import { runD1WithRetry } from '#worker/d1-retry.ts'
import { personalOrgIdFromUserRow } from '#worker/orgs/personal-org-id.ts'
import { hardPurgeOrgDataTargets } from './data-targets.ts'
import {
	logOrgAuditEvent,
	redactOrgAuditActorIdsForDeletedUser,
} from './org-audit.ts'

/**
 * How this org relates to a person account for hard-purge inventory policy.
 * Soft-delete purge processes orgs before users: leave owner-scoped inventory
 * only when a soft-deleted person will purge next. A live matching person
 * (legacy personal-org soft-delete without account deletion) must not lose
 * owner inventory; block until the account is deleted or the org is repaired.
 */
type PersonalOrgHardPurgeRelation =
	| 'soft_deleted_person'
	| 'live_person'
	| 'none'

export class PersonalOrgHardPurgeBlockedForLiveUserError extends Error {
	constructor(orgId: OwnerId) {
		super(`personal_org_hard_purge_blocked_live_user:${orgId}`)
		this.name = 'PersonalOrgHardPurgeBlockedForLiveUserError'
	}
}

async function personalOrgHardPurgeRelation(
	db: D1Database,
	orgId: OwnerId,
): Promise<PersonalOrgHardPurgeRelation> {
	const row = await runD1WithRetry(() =>
		db
			.prepare(
				`SELECT deleted_at FROM users
				 WHERE (
				 	(personal_org_id IS NOT NULL AND TRIM(personal_org_id) != '' AND personal_org_id = ?)
				 	OR ((personal_org_id IS NULL OR TRIM(personal_org_id) = '') AND stable_user_id = ?)
				 )
				 LIMIT 1`,
			)
			.bind(orgId, orgId)
			.first<{ deleted_at: string | null }>(),
	)
	if (!row) return 'none'
	return row.deleted_at ? 'soft_deleted_person' : 'live_person'
}

export async function hardPurgeOrg(input: {
	env: Env
	orgId: OwnerId
}): Promise<void> {
	const db = input.env.APP_DB
	const relation = await personalOrgHardPurgeRelation(db, input.orgId)
	if (relation === 'live_person') {
		throw new PersonalOrgHardPurgeBlockedForLiveUserError(input.orgId)
	}
	const deferOwnerInventory = relation === 'soft_deleted_person'
	if (!deferOwnerInventory) {
		// Team org (no matching person): collect the same out-of-band keys
		// account deletion collects for this owner id, delete those objects,
		// then delete D1 rows (including owner-scoped inventory without
		// deleted_at).
		await purgeOwnerOutOfBandSurfaces({
			env: input.env,
			ownerId: input.orgId,
		})
	}
	const targets = hardPurgeOrgDataTargets(
		deferOwnerInventory ? 'personal' : 'team',
	)
	for (const target of targets) {
		const match = buildUserScopedTargetMatch({
			target,
			mcpUserId: input.orgId,
			dbUserId: -1,
		})
		const { sql, params } = buildUserScopedDeleteOrUpdateSql(match)
		await runD1WithRetry(() =>
			db
				.prepare(sql)
				.bind(...params)
				.run(),
		)
	}
	const orgDelete = await runD1WithRetry(() =>
		db.prepare(`DELETE FROM orgs WHERE id = ?`).bind(input.orgId).run(),
	)
	if ((orgDelete.meta.changes ?? 0) === 0) {
		throw new Error(`org_purge_missing_row:${input.orgId}`)
	}
	await logOrgAuditEvent({
		env: input.env,
		orgId: input.orgId,
		action: 'org.purged',
		result: 'success',
		resourceType: 'org',
		resourceId: input.orgId,
	})
}

export async function hardPurgeSoftDeletedUser(input: {
	env: Env
	dbUserId: number
	stableUserId: OwnerId
}): Promise<void> {
	const personalOrgRow = await runD1WithRetry(() =>
		input.env.APP_DB.prepare(
			`SELECT personal_org_id, stable_user_id FROM users WHERE id = ?`,
		)
			.bind(input.dbUserId)
			.first<{ personal_org_id: string | null; stable_user_id: string }>(),
	)
	const storageOwnerId = personalOrgRow
		? personalOrgIdFromUserRow(personalOrgRow)
		: input.stableUserId
	const personUserId =
		personalOrgRow?.stable_user_id?.trim() || input.stableUserId
	await redactOrgAuditActorIdsForDeletedUser({
		env: input.env,
		userId: input.stableUserId,
	})
	await deleteUserAccount({
		env: input.env,
		dbUserId: input.dbUserId,
		mcpUserId: storageOwnerId,
		personUserId,
		purgeSoftDeleted: true,
	})
	await logOrgAuditEvent({
		env: input.env,
		orgId: storageOwnerId,
		action: 'user.purged',
		result: 'success',
		resourceType: 'user',
		resourceId: input.stableUserId,
		targetUserId: input.stableUserId,
	})
}
