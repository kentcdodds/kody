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
 * True when a soft-deleted `users` row has this org id as its personal org
 * (`users.personal_org_id`, or legacy `stable_user_id` when the column is blank
 * / equal-id). Soft-delete purge processes orgs before users; leave
 * owner-scoped inventory only when that following user purge will run.
 * A live person must not soft-delete their personal org alone
 * ({@link softDeleteOrg}); if one somehow reaches hard purge, treat it as a
 * team org so owner inventory is not stranded.
 */
async function orgIdHasSoftDeletedPersonForDeferredPurge(
	db: D1Database,
	orgId: OwnerId,
) {
	const row = await runD1WithRetry(() =>
		db
			.prepare(
				`SELECT 1 AS ok FROM users
				 WHERE deleted_at IS NOT NULL
				   AND (
				 	(personal_org_id IS NOT NULL AND TRIM(personal_org_id) != '' AND personal_org_id = ?)
				 	OR ((personal_org_id IS NULL OR TRIM(personal_org_id) = '') AND stable_user_id = ?)
				 )`,
			)
			.bind(orgId, orgId)
			.first<{ ok: number }>(),
	)
	return Boolean(row)
}

export async function hardPurgeOrg(input: {
	env: Env
	orgId: OwnerId
}): Promise<void> {
	const db = input.env.APP_DB
	const deferOwnerInventory = await orgIdHasSoftDeletedPersonForDeferredPurge(
		db,
		input.orgId,
	)
	if (!deferOwnerInventory) {
		// Team org, or personal org without a soft-deleted person: collect the
		// same out-of-band keys account deletion collects for this owner id,
		// delete those objects, then delete D1 rows (including owner-scoped
		// inventory without deleted_at).
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
