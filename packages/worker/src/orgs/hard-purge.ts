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
 * True when a `users` row (live or soft-deleted) has this org id as its
 * personal org (`users.personal_org_id`, or legacy `stable_user_id` when the
 * column is blank / equal-id). Soft-delete purge processes orgs before users;
 * leaving owner-scoped inventory for that following user purge avoids
 * orphaning KV/R2 when org id == person id (#3121). Distinct signup org ids
 * (#3053) still count as personal so team-org purge does not race the person
 * purge.
 */
async function orgIdIsPersonAccountId(db: D1Database, orgId: OwnerId) {
	const row = await runD1WithRetry(() =>
		db
			.prepare(
				`SELECT 1 AS ok FROM users
				 WHERE (
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
	const personal = await orgIdIsPersonAccountId(db, input.orgId)
	if (!personal) {
		// Team org: collect the same out-of-band keys account deletion collects
		// for this owner id, delete those objects, then delete D1 rows
		// (including owner-scoped inventory without deleted_at).
		await purgeOwnerOutOfBandSurfaces({
			env: input.env,
			ownerId: input.orgId,
		})
	}
	const targets = hardPurgeOrgDataTargets(personal ? 'personal' : 'team')
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
	await redactOrgAuditActorIdsForDeletedUser({
		env: input.env,
		userId: input.stableUserId,
	})
	await deleteUserAccount({
		env: input.env,
		dbUserId: input.dbUserId,
		mcpUserId: storageOwnerId,
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
