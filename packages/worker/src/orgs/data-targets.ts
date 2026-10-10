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

export type HardPurgeSubject = 'person' | 'org'

/**
 * Org graph rows keyed by `org_id` (or a parent that is). Person deletion
 * anonymizes attribution on these tables instead of deleting the org.
 */
const orgStructuralHardPurgeTargets: ReadonlyArray<UserScopedDataTarget> = [
	{
		kind: 'org_via_parent',
		table: 'grant_permissions',
		parentTable: 'grants',
		parentKey: 'grant_id',
	},
	{ kind: 'org_id', table: 'grants' },
	{
		kind: 'org_via_parent',
		table: 'team_members',
		parentTable: 'teams',
		parentKey: 'team_id',
	},
	{ kind: 'org_id', table: 'teams' },
	{ kind: 'org_id', table: 'org_user_budgets' },
	{ kind: 'org_id', table: 'org_memberships' },
	{ kind: 'org_id', table: 'invites' },
	{ kind: 'org_id', table: 'access_cache' },
	{ kind: 'org_id', table: 'handles' },
]

const orgOwnedUserIdSoftDeleteTableSet = new Set<string>(
	orgOwnedUserIdSoftDeleteTables,
)

/**
 * Org hard purge deletes org-owned rows from the person inventory (same match
 * builders and child-before-parent order) plus the org graph. Integer
 * person-account tables stay on the person subject.
 */
function appliesToOrgHardPurge(target: UserScopedDataTarget): boolean {
	switch (target.kind) {
		case 'user_id':
			return orgOwnedUserIdSoftDeleteTableSet.has(target.table)
		case 'bucket_parent':
			return orgOwnedBucketChildSoftDeleteTables.some(
				(row) =>
					row.child === target.table && row.parent === target.parentTable,
			)
		case 'community_listing_child':
			return true
		case 'user_columns':
			return (
				target.table === 'community_listings' &&
				target.columns.length === 1 &&
				target.columns[0] === 'owner_user_id'
			)
		case 'db_user_id':
		case 'db_user_target':
		case 'null_user_column':
		case 'replace_user_column':
		case 'replace_user_id_in_json_column':
		case 'mcp_memory_suppression':
		case 'org_id':
		case 'org_via_parent':
			return false
		default: {
			const exhaustive: never = target
			throw new Error(
				`Unhandled hard purge target: ${JSON.stringify(exhaustive)}`,
			)
		}
	}
}

/**
 * One hard-purge inventory. `person` is the account-deletion list.
 * `org` is the org-owned subset of that list plus org-graph deletes.
 * The scheduled purge lane still dry-runs while `SOFT_DELETE_PURGE_ENABLED`
 * is false; this function only names the rows.
 */
export function hardPurgeDataTargets(
	subject: HardPurgeSubject,
): ReadonlyArray<UserScopedDataTarget> {
	switch (subject) {
		case 'person':
			return accountUserDataTargets
		case 'org':
			return [
				...accountUserDataTargets.filter(appliesToOrgHardPurge),
				...orgStructuralHardPurgeTargets,
			]
		default: {
			const exhaustive: never = subject
			throw new Error(`Unhandled hard purge subject: ${String(exhaustive)}`)
		}
	}
}
