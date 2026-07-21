export type UserScopedDataTarget =
	| { kind: 'user_id'; table: string }
	| { kind: 'db_user_id'; table: string }
	// Rows keyed by a `target` column holding the stringified database user id
	// (Epic Stack-style verifications: 2fa secrets etc).
	| { kind: 'db_user_target'; table: string }
	| { kind: 'user_columns'; table: string; columns: ReadonlyArray<string> }
	| {
			kind: 'null_user_column'
			table: string
			matchColumn: string
			nullColumns: ReadonlyArray<string>
			includeInExport?: boolean
	  }
	| {
			kind: 'replace_user_column'
			table: string
			matchColumn: string
			setColumn: string
			value: string
	  }
	| { kind: 'bucket_parent'; table: string; parentTable: string }
	| { kind: 'attachment_parent'; table: string }
	| { kind: 'community_listing_child'; table: string; listingColumn: string }
	| { kind: 'mcp_memory_suppression' }

export const accountUserDataExcludedOwnerIds = [
	{
		ownerId: 'system:email',
		surface: 'system_email_inboxes',
		reason:
			'Operator-owned inbound mail for reserved platform locals is stored under the reserved system:email owner id. It is not a user account, must not be attributed to any user, and is excluded from per-user account deletion/export while system retention pruning bounds growth.',
	},
] as const

/**
 * Tables that are scoped by `user_id` (directly or transitively) and should
 * be included in per-user account operations. A cleanup-only reviewer target
 * can opt out of export so it does not disclose another user's content. The
 * list is intentionally explicit so adding a new user-scoped table requires a
 * deliberate update here and a corresponding deletion/export guardrail test
 * update.
 * Rows owned by accountUserDataExcludedOwnerIds are operator/platform data,
 * not user data; tests assert those owner ids stay deliberately excluded from
 * user account operations.
 *
 * Order matters for deletion: child tables come before parent tables so the
 * cascade is self-contained even on engines / configs where foreign-key
 * cascades are disabled. Tables with no `user_id` column (e.g. global mock
 * tables) are not represented.
 */
export const accountUserDataTargets: ReadonlyArray<UserScopedDataTarget> = [
	{ kind: 'user_id', table: 'package_invocations' },
	{ kind: 'user_id', table: 'package_invocation_tokens' },
	{ kind: 'user_id', table: 'workflow_runs' },
	{ kind: 'user_id', table: 'package_runtime_logs' },
	{ kind: 'user_id', table: 'package_runtime_runs' },
	{ kind: 'user_id', table: 'usage_rollups' },
	{ kind: 'user_id', table: 'agent_package_conversation_uses' },
	{ kind: 'mcp_memory_suppression' },
	{ kind: 'user_id', table: 'mcp_memories' },
	{ kind: 'user_id', table: 'mcp_user_server_instructions' },
	{
		kind: 'bucket_parent',
		table: 'value_entries',
		parentTable: 'value_buckets',
	},
	{ kind: 'user_id', table: 'value_buckets' },
	{
		kind: 'bucket_parent',
		table: 'secret_entries',
		parentTable: 'secret_buckets',
	},
	{ kind: 'user_id', table: 'secret_buckets' },
	{ kind: 'user_id', table: 'remote_connector_settings' },
	{ kind: 'user_id', table: 'mcp_server_settings' },
	{ kind: 'user_id', table: 'archived_job_artifacts' },
	{ kind: 'user_id', table: 'published_bundle_artifacts' },
	{ kind: 'user_id', table: 'jobs' },
	{ kind: 'user_id', table: 'repo_sessions' },
	{ kind: 'user_id', table: 'saved_packages' },
	{ kind: 'user_id', table: 'entity_sources' },
	{ kind: 'user_id', table: 'email_delivery_events' },
	{ kind: 'attachment_parent', table: 'email_attachments' },
	{ kind: 'user_id', table: 'email_messages' },
	{ kind: 'user_id', table: 'email_threads' },
	{ kind: 'user_id', table: 'email_inbox_addresses' },
	{ kind: 'user_id', table: 'email_inboxes' },
	{ kind: 'user_id', table: 'email_sender_identities' },
	{ kind: 'user_id', table: 'entitlement_daily_counters' },
	{
		kind: 'user_columns',
		table: 'platform_feedback',
		columns: ['submitter_user_id'],
	},
	// Feedback is owned by its submitter. A reviewer relationship is cleanup
	// metadata only: deleting that reviewer anonymizes the surviving review,
	// but account export must not expose another user's feedback to the reviewer.
	{
		kind: 'null_user_column',
		table: 'platform_feedback',
		matchColumn: 'reviewed_by_user_id',
		nullColumns: ['reviewed_by_user_id', 'reviewed_at', 'admin_note'],
		includeInExport: false,
	},
	{
		kind: 'community_listing_child',
		table: 'community_ratings',
		listingColumn: 'listing_id',
	},
	{ kind: 'user_id', table: 'community_ratings' },
	{
		kind: 'community_listing_child',
		table: 'community_stars',
		listingColumn: 'listing_id',
	},
	{ kind: 'user_id', table: 'community_stars' },
	{
		kind: 'community_listing_child',
		table: 'community_activity_events',
		listingColumn: 'listing_id',
	},
	{
		kind: 'user_columns',
		table: 'community_activity_events',
		columns: ['actor_user_id'],
	},
	{
		kind: 'user_columns',
		table: 'user_follows',
		columns: ['follower_user_id', 'followee_user_id'],
	},
	{
		kind: 'community_listing_child',
		table: 'community_forks',
		listingColumn: 'listing_id',
	},
	{
		kind: 'user_columns',
		table: 'community_forks',
		columns: ['forker_user_id'],
	},
	{
		kind: 'community_listing_child',
		table: 'community_reports',
		listingColumn: 'listing_id',
	},
	{
		kind: 'user_columns',
		table: 'community_reports',
		columns: ['listing_owner_user_id', 'reporter_user_id'],
	},
	{
		kind: 'null_user_column',
		table: 'community_reports',
		matchColumn: 'resolved_by_user_id',
		nullColumns: ['resolved_by_user_id', 'resolved_at', 'resolution_note'],
	},
	// A grant dies with its scope owner or grantee, but survives deletion of
	// the admin who created it (the grant remains valid; only attribution is
	// anonymized, matching community_bans).
	{
		kind: 'user_columns',
		table: 'package_scope_grants',
		columns: ['scope_owner_user_id', 'grantee_user_id'],
	},
	{
		kind: 'replace_user_column',
		table: 'package_scope_grants',
		matchColumn: 'created_by_user_id',
		setColumn: 'created_by_user_id',
		value: 'deleted-user',
	},
	{
		kind: 'user_columns',
		table: 'community_bans',
		columns: ['user_id'],
	},
	{
		kind: 'replace_user_column',
		table: 'community_bans',
		matchColumn: 'banned_by_user_id',
		setColumn: 'banned_by_user_id',
		value: 'deleted-user',
	},
	// Trust marks record which admin reviewed a listing. When that admin's
	// account is deleted the mark itself stays valid (the review happened);
	// only the attribution is anonymized, matching community_bans.
	{
		kind: 'replace_user_column',
		table: 'community_listings',
		matchColumn: 'trusted_by_user_id',
		setColumn: 'trusted_by_user_id',
		value: 'deleted-user',
	},
	{
		kind: 'user_columns',
		table: 'community_listings',
		columns: ['owner_user_id'],
	},
	// password_resets.user_id is an INTEGER FK to users.id (predates the
	// stable mcp string user id), so it must be handled with the database
	// integer id rather than the mcp user id.
	{ kind: 'db_user_id', table: 'email_verifications' },
	{ kind: 'db_user_id', table: 'pending_email_changes' },
	{ kind: 'db_user_id', table: 'password_resets' },
	{ kind: 'db_user_id', table: 'user_roles' },
	{ kind: 'db_user_id', table: 'passkeys' },
	{ kind: 'db_user_id', table: 'oauth_connections' },
	// Feature-flag overrides use the integer users.id FK (with ON DELETE
	// CASCADE), but account deletion still issues an explicit DELETE so the
	// cascade stays self-contained when FK enforcement is disabled.
	{ kind: 'db_user_id', table: 'feature_flag_user_overrides' },
	// Two-factor verification rows are keyed by `target` = stringified db user
	// id rather than a user_id column, so they need the dedicated kind.
	{ kind: 'db_user_target', table: 'verifications' },
]

export function getAccountD1UserColumnCoverage() {
	const covered = new Set<string>()
	covered.add('users.stable_user_id')
	for (const target of accountUserDataTargets) {
		switch (target.kind) {
			case 'user_id':
			case 'db_user_id':
			case 'mcp_memory_suppression': {
				const table =
					target.kind === 'mcp_memory_suppression'
						? 'mcp_memory_conversation_suppressions'
						: target.table
				covered.add(`${table}.user_id`)
				break
			}
			case 'user_columns': {
				for (const column of target.columns) {
					covered.add(`${target.table}.${column}`)
				}
				break
			}
			case 'null_user_column': {
				covered.add(`${target.table}.${target.matchColumn}`)
				break
			}
			case 'replace_user_column': {
				covered.add(`${target.table}.${target.matchColumn}`)
				break
			}
			case 'bucket_parent':
			case 'attachment_parent':
			case 'community_listing_child':
			// db_user_target tables key rows by `target`, not a *_user_id
			// column, so there is no schema column for the guard to cover.
			case 'db_user_target': {
				break
			}
			default: {
				const exhaustive: never = target
				throw new Error(
					`Unhandled account data coverage target: ${JSON.stringify(exhaustive)}`,
				)
			}
		}
	}
	return covered
}
