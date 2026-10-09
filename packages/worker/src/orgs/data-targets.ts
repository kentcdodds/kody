import {
	type UserScopedDataTarget,
	accountUserDataTargets,
} from '#worker/account/data-targets.ts'
import { softDeleteAppTables } from '#worker/soft-delete/tables.ts'

/**
 * APP_DB tables keyed by `user_id` where the owner id is an org stable id
 * (team org or personal org). Used for org soft-delete batch updates and org
 * hard purge D1 inventory.
 */
const orgOwnedUserIdSoftDeleteTableExclusions = new Set([
	'orgs',
	'users',
	'org_memberships',
	'teams',
	'team_members',
	'grants',
	'org_user_budgets',
	// Uses owner_user_id, not user_id.
	'community_listings',
	// Child rows keyed by bucket_id; soft-deleted via parent buckets.
	'secret_entries',
	'value_entries',
])

/** Child tables soft-deleted via their parent bucket after org soft-delete. */
export const orgOwnedBucketChildSoftDeleteTables = [
	{
		child: 'secret_entries',
		parent: 'secret_buckets',
		parentKey: 'bucket_id',
	},
	{
		child: 'value_entries',
		parent: 'value_buckets',
		parentKey: 'bucket_id',
	},
] as const

export const orgOwnedUserIdSoftDeleteTables = softDeleteAppTables.filter(
	(table): table is (typeof softDeleteAppTables)[number] =>
		!orgOwnedUserIdSoftDeleteTableExclusions.has(table),
)

/**
 * Credential surfaces revoked on org soft-delete. Spec §10.3: credentials are
 * not restored even when the org is restored (the user reconnects).
 */
export const orgCredentialTablesExcludedFromRestore = [
	'api_tokens',
	'connection_profiles',
	'user_oauth_apps',
] as const

export const orgOwnedUserIdRestoreTables =
	orgOwnedUserIdSoftDeleteTables.filter(
		(table) =>
			!(
				orgCredentialTablesExcludedFromRestore as ReadonlyArray<string>
			).includes(table),
	)

/** Tables with an `org_id` column and `deleted_at` (Teams expand). */
export const orgScopedOrgIdSoftDeleteTables = [
	'org_memberships',
	'teams',
	'grants',
	'org_user_budgets',
] as const

/**
 * D1 deletion targets for hard-purging one org (owner id = org id on user_id
 * rows). Interim dual path: person account hard delete still uses
 * `accountUserDataTargets` in `#app/account-deletion.ts`. File a cleanup issue
 * to unify org vs person inventories once org purge soaks.
 */
export const orgHardPurgeDataTargets: ReadonlyArray<UserScopedDataTarget> =
	orgOwnedUserIdSoftDeleteTables.map((table) => ({
		kind: 'user_id',
		table,
	}))

/** Re-export for callers that need the full person account inventory. */
export { accountUserDataTargets }
