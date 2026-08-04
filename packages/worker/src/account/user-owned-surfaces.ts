export type UserOwnedDurableObjectSurface = {
	id:
		| 'job_manager'
		| 'storage_runner'
		| 'repo_session'
		| 'remote_connector_session'
		| 'mcp_client_hub'
		| 'package_realtime_session'
		| 'package_service_instance'
		| 'run_log'
		| 'user_meter'
		| 'stripe_plan_refresh'
		| 'mailbox'
		| 'mcp'
	binding: string
	/** Result key used in AccountDeletionResult.clearedDurableObjects when purged */
	deletionResultKey: string | null
	export: 'include' | 'exclude'
	excludeReason?: string
	notes?: string
}

export type UserOwnedVectorizeSurface = {
	id: 'memory' | 'job' | 'saved_package'
	sourceTable: 'mcp_memories' | 'jobs' | 'saved_packages'
	/** Exported as derivedData.vectorize note; never exported as vectors */
	export: 'rebuild_from_d1'
}

export type UserOwnedKvKeyScheme = {
	id:
		| 'published_bundle_artifact_kv_key'
		| 'source_snapshot'
		| 'source_manifest_snapshot'
		| 'community_snapshot'
		| 'community_icon_derived_cache'
		| 'usage_rollup_derived_cache'
		| 'package_retriever_manifest'
		| 'package_retriever_index_entry'
		| 'package_retriever_index_prefix'
	binding: 'BUNDLE_ARTIFACTS_KV'
	sourceTable?: string
	sourceColumn?: string
	prefixTemplate?: string
	retention?: string
	notes?: string
}

export type UserOwnedR2Surface = {
	id:
		| 'email_raw_mime'
		| 'email_attachment_storage_key'
		| 'community_icon'
		| 'user_avatar'
	binding: 'EMAIL_BLOBS' | 'COMMUNITY_ASSETS'
	sourceTable: string
	sourceColumn?: string
	keyTemplate?: string
	export: 'chunked_bytes'
	notes?: string
}

export type UserOwnedArtifactSurface = {
	id: 'entity_sources' | 'repo_sessions'
	sourceTable: string
	repoColumn: string
	notes: string
}

export const accountUserOwnedDurableObjectSurfaces: ReadonlyArray<UserOwnedDurableObjectSurface> =
	[
		{
			id: 'job_manager',
			binding: 'JOB_MANAGER',
			deletionResultKey: 'jobManagers',
			export: 'include',
			notes: 'Job manager state is included in account export.',
		},
		{
			id: 'storage_runner',
			binding: 'STORAGE_RUNNER',
			deletionResultKey: 'storageRunners',
			export: 'include',
		},
		{
			id: 'repo_session',
			binding: 'REPO_SESSION',
			deletionResultKey: 'repoSessions',
			export: 'exclude',
			excludeReason:
				'Ephemeral editing workspace. Canonical repo-backed source is exported as Artifacts repo pointers via entity_sources and repo_sessions metadata.',
		},
		{
			id: 'remote_connector_session',
			binding: 'REMOTE_CONNECTOR_SESSION',
			deletionResultKey: 'remoteConnectorSessions',
			export: 'include',
		},
		{
			id: 'mcp_client_hub',
			binding: 'MCP_CLIENT_HUB',
			deletionResultKey: 'mcpClientHubs',
			export: 'exclude',
			excludeReason:
				'MCP client hub state can include OAuth tokens and SDK registrations that are non-portable; it is purged during account deletion instead of exported.',
		},
		{
			id: 'package_realtime_session',
			binding: 'PACKAGE_REALTIME_SESSION',
			deletionResultKey: 'packageRealtimeSessions',
			export: 'exclude',
			excludeReason:
				'Ephemeral live websocket/session state. Durable app storage is exported through StorageRunner buckets.',
		},
		{
			id: 'package_service_instance',
			binding: 'PACKAGE_SERVICE_INSTANCE',
			deletionResultKey: 'packageServiceInstances',
			export: 'include',
		},
		{
			id: 'run_log',
			binding: 'RUN_LOG',
			deletionResultKey: 'runLogs',
			export: 'include',
			notes:
				'Per-user RunLog DO (RUN_LOG binding; idFromName(userId)). Sole runtime authority for pruned run history (runs + run_logs), the keyed package-invocation idempotency ledger, and dedicated state: workflow_projections (binding_name, typically DYNAMIC_CALLABLE_WORKFLOWS; terminal rows age-prune after 90 days), job_run_observability (terminal outcomes/counters; D1 jobs keeps schedule + last_run_at/last_run_status for retention only), package_run_successes, and activation_milestones. Legacy D1 projection tables workflow_runs, user_package_run_successes, and user_activation_milestones were retired by migration 0137 (pre-migration Time Travel bookmark 0000116d-000000d2-000050bd-c7ecd5892a189df7cda145af746bc9c9 on database 8c1014d1-6b41-4695-a0a2-159071f0f919). Run history self-prunes (~30 days / 2,000 runs); job/activation dedicated tables are never pruned. Account deletion clearAll deletes every DO table and reinitializes schema. Account export pages all tables through the run_records section (runs first, then ledger, then dedicated phases).',
		},
		{
			id: 'user_meter',
			binding: 'USER_METER',
			deletionResultKey: 'userMeters',
			export: 'include',
			notes:
				'Per-user daily entitlement counters, storage-byte state, package-service liveness, and deletion-fence/write-lease state (one DO per stable userId). Daily counters, storage bytes, and package-service running counts are authoritative in UserMeter; the retired users.d1_storage_bytes mirror columns were dropped by migration 0139; the reconcile lane sweeps users by stable_user_id keyset from the platform-owned d1_storage_reconcile_cursor row. UserMeter is the sole lease authority: all callers (including email paths) supply USER_METER via env; acquireWriteLease writes to the DO only and countActiveWriteLeases is a direct DO COUNT (no paging). Migration 0141 dropped the retired D1 account_write_leases table; D1 users.deleting_at remains the permanent point gate and account_write_lease_repairs remains the admin repair audit log. Self-prunes stale UTC-day rows inside the DO rather than through a retention cron lane; account deletion purge clears counters, storage-byte state, package-service liveness, and write leases while preserving an existing deleting tombstone; account export pages counters through the user_meter section via exportCounters and includes authoritative storageBytesState, packageServiceStates, and sanitized deletionState without raw lease token/holder on the first page only.',
		},
		{
			id: 'stripe_plan_refresh',
			binding: 'STRIPE_PLAN_REFRESH',
			deletionResultKey: 'stripePlanRefreshes',
			export: 'exclude',
			excludeReason:
				'Ephemeral one-shot Stripe reconciliation alarm state. Billing columns remain canonical in D1 and are included in the users export.',
			notes:
				'One alarm object per stable userId. Account deletion cancels the alarm and clears its stored owner id.',
		},
		{
			id: 'mailbox',
			binding: 'MAILBOX',
			deletionResultKey: 'mailboxes',
			export: 'include',
			notes:
				'Per-user authoritative email metadata and R2-reference inventory (MAILBOX binding; idFromName(userId)). Account export pages the sole USER email graph through exportMailbox. Account deletion lists Mailbox blob references before deleting R2 objects and purging the DO; D1 retains only thin provider, due-work, alert, and configuration rows.',
		},
		{
			id: 'mcp',
			binding: 'MCP',
			deletionResultKey: 'mcpAgentSessions',
			export: 'exclude',
			excludeReason:
				'Session-keyed by the MCP SDK and not globally enumerable; durable user data is carried by D1 and user-scoped stores instead.',
			notes:
				'Session DO ids are indexed by user in mcp_agent_sessions and purged during account deletion.',
		},
	] as const

export const accountUserOwnedVectorizeSurfaces: ReadonlyArray<UserOwnedVectorizeSurface> =
	[
		{
			id: 'memory',
			sourceTable: 'mcp_memories',
			export: 'rebuild_from_d1',
		},
		{ id: 'job', sourceTable: 'jobs', export: 'rebuild_from_d1' },
		{
			id: 'saved_package',
			sourceTable: 'saved_packages',
			export: 'rebuild_from_d1',
		},
	] as const

export const accountUserOwnedKvKeySchemes: ReadonlyArray<UserOwnedKvKeyScheme> =
	[
		{
			id: 'published_bundle_artifact_kv_key',
			binding: 'BUNDLE_ARTIFACTS_KV',
			sourceTable: 'published_bundle_artifacts',
			sourceColumn: 'kv_key',
			prefixTemplate: 'bundle-artifact:v1:',
		},
		{
			id: 'source_snapshot',
			binding: 'BUNDLE_ARTIFACTS_KV',
			prefixTemplate: 'source-snapshot:v1:{sourceId}:',
		},
		{
			id: 'source_manifest_snapshot',
			binding: 'BUNDLE_ARTIFACTS_KV',
			prefixTemplate: 'source-manifest-snapshot:v1:{sourceId}:',
		},
		{
			id: 'community_snapshot',
			binding: 'BUNDLE_ARTIFACTS_KV',
			prefixTemplate: 'community-snapshot:v1:',
		},
		{
			id: 'community_icon_derived_cache',
			binding: 'BUNDLE_ARTIFACTS_KV',
			prefixTemplate: 'derived-cache:v1:community-icon:v1:{listingId}:',
			notes:
				'Derived cache key from derivedCacheKeyPrefix + buildCommunityIconCacheKey.',
		},
		{
			id: 'usage_rollup_derived_cache',
			binding: 'BUNDLE_ARTIFACTS_KV',
			prefixTemplate: 'derived-cache:v1:usage-rollups:user:{userId}:',
			retention:
				'Expires through the KV expirationTtl written by the cachified adapter; the configured retention is five minutes.',
			notes:
				'Short-lived derived admin read model. Immediate account-deletion cleanup is optional because KV enforces the TTL.',
		},
		{
			id: 'package_retriever_manifest',
			binding: 'BUNDLE_ARTIFACTS_KV',
			prefixTemplate: 'package-retriever-manifest:v1:{userId}:{packageId}:',
			notes: 'Deleted by deleteAllPackageRetrieverCacheEntriesForUser.',
		},
		{
			id: 'package_retriever_index_entry',
			binding: 'BUNDLE_ARTIFACTS_KV',
			prefixTemplate:
				'package-retriever-index-entry:v1:{userId}:{scope}:{packageId}:',
			notes: 'Deleted by deleteAllPackageRetrieverCacheEntriesForUser.',
		},
	] as const

export const accountUserOwnedR2Surfaces: ReadonlyArray<UserOwnedR2Surface> = [
	{
		id: 'email_raw_mime',
		binding: 'EMAIL_BLOBS',
		sourceTable: 'Mailbox.email_messages',
		sourceColumn: 'id',
		keyTemplate: 'email-raw:v1:{userId}/{messageId}',
		export: 'chunked_bytes',
		notes:
			'Authoritative references come from Mailbox.listBlobReferences; canonical key generated by emailRawMimeKey.',
	},
	{
		id: 'email_attachment_storage_key',
		binding: 'EMAIL_BLOBS',
		sourceTable: 'Mailbox.email_attachments',
		sourceColumn: 'storage_key',
		keyTemplate: 'email-attachment:v1:{userId}/{messageId}/{attachmentId}',
		export: 'chunked_bytes',
		notes:
			'Authoritative owner-safe references come from Mailbox.listBlobReferences.',
	},
	{
		id: 'community_icon',
		binding: 'COMMUNITY_ASSETS',
		sourceTable: 'community_listings',
		keyTemplate: 'community-icon:v1/{listingId}/{commit}/asset',
		export: 'chunked_bytes',
	},
	{
		id: 'user_avatar',
		binding: 'COMMUNITY_ASSETS',
		sourceTable: 'users',
		sourceColumn: 'avatar_key',
		export: 'chunked_bytes',
	},
] as const

export const accountUserOwnedArtifactSurfaces: ReadonlyArray<UserOwnedArtifactSurface> =
	[
		{
			id: 'entity_sources',
			sourceTable: 'entity_sources',
			repoColumn: 'repo_id',
			notes:
				'Cloudflare Artifacts repos cleaned by cleanupAllUserArtifactRepos.',
		},
		{
			id: 'repo_sessions',
			sourceTable: 'repo_sessions',
			repoColumn: 'source_repo_id',
			notes:
				'Cloudflare Artifacts repos cleaned by cleanupAllUserArtifactRepos.',
		},
	] as const

const accountExportExcludedDurableObjectDisplayNames: Readonly<
	Record<
		'mcp' | 'repo_session' | 'package_realtime_session' | 'stripe_plan_refresh',
		string
	>
> = {
	mcp: 'MCP',
	repo_session: 'RepoSession',
	package_realtime_session: 'PackageRealtimeSession',
	stripe_plan_refresh: 'StripePlanRefresh',
} as const

export function getAccountExportExcludedDurableObjects(): Array<{
	name: string
	reason: string
}> {
	return (
		[
			'mcp',
			'repo_session',
			'package_realtime_session',
			'stripe_plan_refresh',
		] satisfies Array<
			keyof typeof accountExportExcludedDurableObjectDisplayNames
		>
	).map((id) => {
		const surface = accountUserOwnedDurableObjectSurfaces.find(
			(candidate) => candidate.id === id,
		)
		if (!surface || surface.export !== 'exclude' || !surface.excludeReason) {
			throw new Error(`Missing account export durable object exclusion: ${id}`)
		}
		return {
			name: accountExportExcludedDurableObjectDisplayNames[id],
			reason: surface.excludeReason,
		}
	})
}

export function getAccountDeletionDurableObjectResultKeys(): ReadonlyArray<string> {
	return accountUserOwnedDurableObjectSurfaces
		.map((surface) => surface.deletionResultKey)
		.filter((key): key is string => key !== null)
}

export function getAccountUserOwnedSurfaceCoverage(): {
	durableObjectIds: ReadonlySet<string>
	vectorizeIds: ReadonlySet<string>
	kvSchemeIds: ReadonlySet<string>
	r2SurfaceIds: ReadonlySet<string>
	artifactSurfaceIds: ReadonlySet<string>
} {
	return {
		durableObjectIds: new Set(
			accountUserOwnedDurableObjectSurfaces.map((surface) => surface.id),
		),
		vectorizeIds: new Set(
			accountUserOwnedVectorizeSurfaces.map((surface) => surface.id),
		),
		kvSchemeIds: new Set(
			accountUserOwnedKvKeySchemes.map((scheme) => scheme.id),
		),
		r2SurfaceIds: new Set(
			accountUserOwnedR2Surfaces.map((surface) => surface.id),
		),
		artifactSurfaceIds: new Set(
			accountUserOwnedArtifactSurfaces.map((surface) => surface.id),
		),
	}
}
