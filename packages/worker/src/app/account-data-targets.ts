export type UserScopedDataTarget =
	| {
			kind: 'user_id'
			table: string
			/**
			 * When false, account deletion still clears the table by user_id, but
			 * account export skips the rows. Provide surface/reason so the export
			 * manifest documents the deliberate omission.
			 */
			includeInExport?: boolean
			surface?: string
			reason?: string
	  }
	| { kind: 'db_user_id'; table: string }
	// Rows keyed by a `target` column holding the stringified database user id
	// (Epic Stack-style verifications: 2fa secrets etc).
	| { kind: 'db_user_target'; table: string }
	| {
			kind: 'user_columns'
			table: string
			columns: ReadonlyArray<string>
			includeInExport?: boolean
			surface?: string
			reason?: string
	  }
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
	| {
			kind: 'community_listing_child'
			table: string
			listingColumn: string
			includeInExport?: boolean
			surface?: string
			reason?: string
	  }
	| { kind: 'mcp_memory_suppression' }

export const accountUserDataExcludedOwnerIds = [
	{
		ownerId: 'system:email',
		surface: 'system_email_inboxes',
		reason:
			'Operator-owned inbound mail for reserved platform locals is stored under the reserved system:email owner id. It is not a user account, must not be attributed to any user, and is excluded from per-user account deletion/export while system retention pruning bounds growth.',
	},
] as const

/** Targets that account export should skip (deletion still covers them). */
export function isExcludedFromAccountExport(
	target: UserScopedDataTarget,
): boolean {
	return 'includeInExport' in target && target.includeInExport === false
}

/**
 * Documented D1 surfaces omitted from account export. Includes owner-id
 * exclusions plus targets marked includeInExport: false with surface/reason.
 */
export function getAccountExportExcludedD1Surfaces(): Array<{
	name: string
	reason: string
}> {
	const surfaces: Array<{ name: string; reason: string }> = [
		...accountUserDataExcludedOwnerIds.map((exclusion) => ({
			name: exclusion.surface,
			reason: exclusion.reason,
		})),
	]
	for (const target of accountUserDataTargets) {
		if (!isExcludedFromAccountExport(target)) continue
		if (
			'surface' in target &&
			'reason' in target &&
			typeof target.surface === 'string' &&
			typeof target.reason === 'string'
		) {
			surfaces.push({ name: target.surface, reason: target.reason })
		}
	}
	return surfaces
}

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
	{ kind: 'user_id', table: 'package_service_states' },
	{ kind: 'user_id', table: 'usage_rollups' },
	{ kind: 'user_id', table: 'user_activation_milestones' },
	{ kind: 'user_id', table: 'user_package_run_successes' },
	{ kind: 'user_id', table: 'agent_package_conversation_uses' },
	{ kind: 'mcp_memory_suppression' },
	{ kind: 'user_id', table: 'mcp_memories' },
	{ kind: 'user_id', table: 'mcp_user_server_instructions' },
	{ kind: 'user_id', table: 'mcp_agent_sessions' },
	{ kind: 'user_id', table: 'account_write_leases' },
	{
		kind: 'replace_user_column',
		table: 'account_write_lease_repairs',
		matchColumn: 'target_user_id',
		setColumn: 'target_user_id',
		value: 'deleted-user',
	},
	{
		kind: 'replace_user_column',
		table: 'account_write_lease_repairs',
		matchColumn: 'repaired_by_user_id',
		setColumn: 'repaired_by_user_id',
		value: 'deleted-user',
	},
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
	{ kind: 'user_id', table: 'webhook_deliveries' },
	{ kind: 'user_id', table: 'webhook_endpoints' },
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
		includeInExport: false,
		surface: 'community_listing_ratings_by_other_users',
		reason:
			'Ratings belong in the rating author export. Listing-owner deletion still cascades them, but listing-owner export must not disclose another user’s identity, score, or note.',
	},
	{ kind: 'user_id', table: 'community_ratings' },
	{
		kind: 'community_listing_child',
		table: 'community_stars',
		listingColumn: 'listing_id',
		includeInExport: false,
		surface: 'community_listing_stars_by_other_users',
		reason:
			'Stars belong in the stargazer export. Listing-owner deletion still cascades them, but listing-owner export must not disclose another user’s bookmark or its timestamp.',
	},
	{ kind: 'user_id', table: 'community_stars' },
	{
		kind: 'community_listing_child',
		table: 'community_activity_events',
		listingColumn: 'listing_id',
		includeInExport: false,
		surface: 'community_listing_activity_by_other_users',
		reason:
			'Stored community activity belongs in the actor export. Listing-owner deletion still cascades it, but listing-owner export must not disclose another actor’s event type or timestamp.',
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
		includeInExport: false,
		surface: 'community_listing_forks_by_other_users',
		reason:
			'Fork and adoption records belong in the forking user export. Listing-owner deletion still cascades them, but listing-owner export must not disclose another user’s identity or adoption note.',
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
		includeInExport: false,
		surface: 'community_listing_reports_by_other_users',
		reason:
			'Community reports are attributed moderation submissions. Listing-owner deletion still cascades them, but listing-owner export must not disclose reporter identity, report reasons, or moderation notes.',
	},
	{
		kind: 'user_columns',
		table: 'community_reports',
		columns: ['listing_owner_user_id', 'reporter_user_id'],
		includeInExport: false,
		surface: 'community_report_deletion_parties',
		reason:
			'This combined predicate exists for deletion. Export ownership is limited to the separate reporter predicate so listing owners cannot receive reports about their listings.',
	},
	{
		kind: 'user_columns',
		table: 'community_reports',
		columns: ['reporter_user_id'],
	},
	{
		kind: 'null_user_column',
		table: 'community_reports',
		matchColumn: 'resolved_by_user_id',
		nullColumns: ['resolved_by_user_id', 'resolved_at', 'resolution_note'],
		includeInExport: false,
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

/**
 * Shared match predicate for a user-scoped D1 target. Account deletion wraps
 * this in DELETE/UPDATE; account export uses the table-qualified form in
 * SELECT WHERE clauses. Keep both SQL shapes here so the two paths cannot
 * drift.
 */
export type UserScopedTargetMatch = {
	table: string
	/** Unqualified boolean SQL for DELETE/UPDATE WHERE clauses. */
	whereSql: string
	/** Table-qualified boolean SQL for SELECT WHERE clauses. */
	qualifiedWhereSql: string
	params: ReadonlyArray<unknown>
	mutation:
		| { kind: 'delete' }
		| { kind: 'null_columns'; columns: ReadonlyArray<string> }
		| { kind: 'replace_column'; column: string; value: string }
}

export function resolveUserScopedTargetTable(
	target: UserScopedDataTarget,
): string {
	switch (target.kind) {
		case 'mcp_memory_suppression': {
			return 'mcp_memory_conversation_suppressions'
		}
		case 'attachment_parent': {
			return 'email_attachments'
		}
		case 'user_id':
		case 'db_user_id':
		case 'db_user_target':
		case 'user_columns':
		case 'null_user_column':
		case 'replace_user_column':
		case 'bucket_parent':
		case 'community_listing_child': {
			return target.table
		}
		default: {
			const exhaustive: never = target
			throw new Error(
				`Unhandled user-scoped target table: ${JSON.stringify(exhaustive)}`,
			)
		}
	}
}

export function buildUserScopedTargetMatch(input: {
	target: UserScopedDataTarget
	mcpUserId: string
	dbUserId: number
}): UserScopedTargetMatch {
	const { target } = input
	const table = resolveUserScopedTargetTable(target)
	switch (target.kind) {
		case 'user_id': {
			return {
				table,
				whereSql: 'user_id = ?',
				qualifiedWhereSql: `${table}.user_id = ?`,
				params: [input.mcpUserId],
				mutation: { kind: 'delete' },
			}
		}
		case 'db_user_id': {
			return {
				table,
				whereSql: 'user_id = ?',
				qualifiedWhereSql: `${table}.user_id = ?`,
				params: [input.dbUserId],
				mutation: { kind: 'delete' },
			}
		}
		case 'db_user_target': {
			return {
				table,
				whereSql: 'target = ?',
				qualifiedWhereSql: `${table}.target = ?`,
				params: [String(input.dbUserId)],
				mutation: { kind: 'delete' },
			}
		}
		case 'user_columns': {
			return {
				table,
				whereSql: target.columns.map((column) => `${column} = ?`).join(' OR '),
				qualifiedWhereSql: target.columns
					.map((column) => `${table}.${column} = ?`)
					.join(' OR '),
				params: target.columns.map(() => input.mcpUserId),
				mutation: { kind: 'delete' },
			}
		}
		case 'null_user_column': {
			return {
				table,
				whereSql: `${target.matchColumn} = ?`,
				qualifiedWhereSql: `${table}.${target.matchColumn} = ?`,
				params: [input.mcpUserId],
				mutation: { kind: 'null_columns', columns: target.nullColumns },
			}
		}
		case 'replace_user_column': {
			return {
				table,
				whereSql: `${target.matchColumn} = ?`,
				qualifiedWhereSql: `${table}.${target.matchColumn} = ?`,
				params: [input.mcpUserId],
				mutation: {
					kind: 'replace_column',
					column: target.setColumn,
					value: target.value,
				},
			}
		}
		case 'bucket_parent': {
			const whereSql = `bucket_id IN (
						SELECT id FROM ${target.parentTable} WHERE user_id = ?
					)`
			return {
				table,
				whereSql,
				qualifiedWhereSql: `${table}.${whereSql}`,
				params: [input.mcpUserId],
				mutation: { kind: 'delete' },
			}
		}
		case 'attachment_parent': {
			const whereSql = `message_id IN (
						SELECT id FROM email_messages WHERE user_id = ?
					)`
			return {
				table,
				whereSql,
				qualifiedWhereSql: `email_attachments.${whereSql}`,
				params: [input.mcpUserId],
				mutation: { kind: 'delete' },
			}
		}
		case 'community_listing_child': {
			const whereSql = `${target.listingColumn} IN (
						SELECT id FROM community_listings WHERE owner_user_id = ?
					)`
			return {
				table,
				whereSql,
				qualifiedWhereSql: `${table}.${whereSql}`,
				params: [input.mcpUserId],
				mutation: { kind: 'delete' },
			}
		}
		case 'mcp_memory_suppression': {
			return {
				table,
				whereSql: 'user_id = ?',
				qualifiedWhereSql: `${table}.user_id = ?`,
				params: [input.mcpUserId],
				mutation: { kind: 'delete' },
			}
		}
		default: {
			const exhaustive: never = target
			throw new Error(
				`Unhandled user-scoped target match: ${JSON.stringify(exhaustive)}`,
			)
		}
	}
}

export function buildUserScopedDeleteOrUpdateSql(
	match: UserScopedTargetMatch,
): { sql: string; params: ReadonlyArray<unknown> } {
	switch (match.mutation.kind) {
		case 'delete': {
			return {
				sql: `DELETE FROM ${match.table} WHERE ${match.whereSql}`,
				params: match.params,
			}
		}
		case 'null_columns': {
			return {
				sql: `UPDATE ${match.table}
						SET ${match.mutation.columns.map((column) => `${column} = NULL`).join(', ')}
						WHERE ${match.whereSql}`,
				params: match.params,
			}
		}
		case 'replace_column': {
			return {
				sql: `UPDATE ${match.table}
						SET ${match.mutation.column} = ?
						WHERE ${match.whereSql}`,
				params: [match.mutation.value, ...match.params],
			}
		}
		default: {
			const exhaustive: never = match.mutation
			throw new Error(
				`Unhandled user-scoped mutation: ${JSON.stringify(exhaustive)}`,
			)
		}
	}
}

// Secret values and credential-equivalent hashes must never leave Kody through
// account export. Secret entries are metadata-only; encrypted payloads stay
// server-side and token/password hashes are omitted for the same reason.
export const accountExportRedactedColumnsByTable: Readonly<
	Record<string, ReadonlyArray<string>>
> = {
	email_verifications: ['token_hash'],
	package_invocation_tokens: ['token_hash'],
	password_resets: ['token_hash'],
	pending_email_changes: ['token_hash'],
	platform_feedback: ['reviewed_by_user_id', 'reviewed_at', 'admin_note'],
	remote_connector_settings: ['encrypted_shared_secret'],
	secret_entries: ['encrypted_value', 'lookup_hash'],
	users: ['password_hash'],
	verifications: ['secret'],
	webhook_endpoints: ['url_secret_hash'],
}

// Social-graph export rows can include another user's stable id. Keep the
// exporter's own id; replace every other value in these columns.
export const accountExportForeignUserIdColumnsByTable: Readonly<
	Record<string, ReadonlyArray<string>>
> = {
	user_follows: ['follower_user_id', 'followee_user_id'],
	community_stars: ['user_id'],
	community_activity_events: ['actor_user_id'],
	community_reports: ['listing_owner_user_id', 'resolved_by_user_id'],
	account_write_lease_repairs: ['target_user_id', 'repaired_by_user_id'],
	package_scope_grants: [
		'scope_owner_user_id',
		'grantee_user_id',
		'created_by_user_id',
	],
}

export const accountExportRedactedForeignUserId = '[redacted]'
