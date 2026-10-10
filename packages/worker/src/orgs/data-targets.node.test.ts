import { readFileSync } from 'node:fs'
import { expect, test } from 'vitest'
import {
	accountUserDataTargets,
	buildUserScopedDeleteOrUpdateSql,
	buildUserScopedTargetMatch,
	type UserScopedDataTarget,
} from '#worker/account/data-targets.ts'
import {
	hardPurgeDataTargets,
	orgOwnedBucketChildSoftDeleteTables,
	orgOwnedUserIdSoftDeleteTables,
} from './data-targets.ts'

function sqlFor(target: UserScopedDataTarget) {
	const match = buildUserScopedTargetMatch({
		target,
		mcpUserId: 'org-1',
		dbUserId: -1,
	})
	return buildUserScopedDeleteOrUpdateSql(match).sql
}

test('person hard purge is the account inventory', () => {
	expect(hardPurgeDataTargets('person')).toBe(accountUserDataTargets)
})

test('org hard purge is the org-owned slice of the account inventory plus the org graph', () => {
	const orgTargets = hardPurgeDataTargets('org')
	const kinds = new Set(orgTargets.map((target) => target.kind))
	expect(kinds.has('db_user_id')).toBe(false)
	expect(kinds.has('db_user_target')).toBe(false)
	expect(kinds.has('replace_user_column')).toBe(false)
	expect(
		orgTargets.some(
			(target) => 'table' in target && target.table === 'passkeys',
		),
	).toBe(false)

	const userIdTables = orgTargets
		.filter((target) => target.kind === 'user_id')
		.map((target) => target.table)
	for (const table of orgOwnedUserIdSoftDeleteTables) {
		if (table === 'email_notification_destinations') {
			expect(userIdTables).not.toContain(table)
			continue
		}
		expect(userIdTables).toContain(table)
	}

	for (const child of orgOwnedBucketChildSoftDeleteTables) {
		const childIndex = orgTargets.findIndex(
			(target) =>
				target.kind === 'bucket_parent' && target.table === child.child,
		)
		const parentIndex = orgTargets.findIndex(
			(target) => target.kind === 'user_id' && target.table === child.parent,
		)
		expect(childIndex).toBeGreaterThanOrEqual(0)
		expect(parentIndex).toBeGreaterThan(childIndex)
	}

	const listingChild = orgTargets.findIndex(
		(target) => target.kind === 'community_listing_child',
	)
	const listingParent = orgTargets.findIndex(
		(target) =>
			target.kind === 'user_columns' && target.table === 'community_listings',
	)
	expect(listingChild).toBeGreaterThanOrEqual(0)
	expect(listingParent).toBeGreaterThan(listingChild)

	const grantPermissions = orgTargets.findIndex(
		(target) =>
			target.kind === 'org_via_parent' && target.table === 'grant_permissions',
	)
	const grants = orgTargets.findIndex(
		(target) => target.kind === 'org_id' && target.table === 'grants',
	)
	expect(grantPermissions).toBeGreaterThanOrEqual(0)
	expect(grants).toBeGreaterThan(grantPermissions)
	expect(sqlFor(orgTargets[grants]!)).toBe(
		'DELETE FROM grants WHERE org_id = ?',
	)
	expect(sqlFor(orgTargets[grantPermissions]!)).toContain(
		'SELECT id FROM grants WHERE org_id = ?',
	)
})

test('wrangler keeps soft-delete purge writes disabled', () => {
	const wrangler = readFileSync(
		new URL('../../wrangler.jsonc', import.meta.url),
		'utf8',
	)
	expect(wrangler).toContain('"SOFT_DELETE_PURGE_ENABLED": "false"')
	expect(wrangler).not.toContain('"SOFT_DELETE_PURGE_ENABLED": "true"')
})
