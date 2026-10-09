// soft-delete-read-filter: opt-out
import {
	buildUserScopedDeleteOrUpdateSql,
	buildUserScopedTargetMatch,
} from '#worker/account/data-targets.ts'
import { deleteUserAccount } from '#app/account-deletion.ts'
import { runD1WithRetry } from '#worker/d1-retry.ts'
import { purgeJobManagerForUser } from '#worker/jobs/manager-client.ts'
import { jobsData } from '#worker/jobs/jobs-data.ts'
import { orgHardPurgeDataTargets } from './data-targets.ts'
import {
	logOrgAuditEvent,
	redactOrgAuditActorIdsForDeletedUser,
} from './org-audit.ts'

async function deleteOrgIdScopedRows(input: { db: D1Database; orgId: string }) {
	const tables = [
		'grant_permissions',
		'grants',
		'team_members',
		'teams',
		'org_user_budgets',
		'org_memberships',
		'invites',
		'access_cache',
		'handles',
	] as const
	for (const table of tables) {
		let sql: string
		if (table === 'team_members') {
			sql = `DELETE FROM team_members
				WHERE team_id IN (SELECT id FROM teams WHERE org_id = ?)`
		} else if (table === 'grant_permissions') {
			sql = `DELETE FROM grant_permissions
				WHERE grant_id IN (SELECT id FROM grants WHERE org_id = ?)`
		} else if (table === 'handles') {
			sql = `DELETE FROM handles WHERE org_id = ?`
		} else {
			sql = `DELETE FROM ${table} WHERE org_id = ?`
		}
		await runD1WithRetry(() => input.db.prepare(sql).bind(input.orgId).run())
	}
}

export async function hardPurgeOrg(input: {
	env: Env
	orgId: string
}): Promise<void> {
	const db = input.env.APP_DB
	for (const target of orgHardPurgeDataTargets) {
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
	await deleteOrgIdScopedRows({ db, orgId: input.orgId })
	const orgDelete = await runD1WithRetry(() =>
		db.prepare(`DELETE FROM orgs WHERE id = ?`).bind(input.orgId).run(),
	)
	if ((orgDelete.meta.changes ?? 0) === 0) {
		throw new Error(`org_purge_missing_row:${input.orgId}`)
	}
	await purgeJobManagerForUser({ env: input.env, userId: input.orgId })
	await jobsData(input.env).purgeUserJobsData({ userId: input.orgId })
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
	stableUserId: string
}): Promise<void> {
	await redactOrgAuditActorIdsForDeletedUser({
		env: input.env,
		userId: input.stableUserId,
	})
	await deleteUserAccount({
		env: input.env,
		dbUserId: input.dbUserId,
		mcpUserId: input.stableUserId,
	})
	await logOrgAuditEvent({
		env: input.env,
		orgId: input.stableUserId,
		action: 'user.purged',
		result: 'success',
		resourceType: 'user',
		resourceId: input.stableUserId,
		targetUserId: input.stableUserId,
	})
}
