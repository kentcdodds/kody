export type UserOwnedDurableObjectSurface = {
	id:
		| 'job_manager'
		| 'storage_runner'
		| 'repo_session'
		| 'remote_connector_session'
		| 'mcp_client_hub'
		| 'package_realtime_session'
		| 'package_service_instance'
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
		| 'package_retriever_manifest'
		| 'package_retriever_index_entry'
		| 'package_retriever_index_prefix'
	binding: 'BUNDLE_ARTIFACTS_KV'
	sourceTable?: string
	sourceColumn?: string
	prefixTemplate?: string
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
			id: 'mcp',
			binding: 'MCP',
			deletionResultKey: null,
			export: 'exclude',
			excludeReason:
				'Session-keyed by the MCP SDK and not globally enumerable; durable user data is carried by D1 and user-scoped stores instead.',
			notes:
				'Export-excluded only; not purged by account deletion enumeration.',
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
		{
			id: 'package_retriever_index_prefix',
			binding: 'BUNDLE_ARTIFACTS_KV',
			prefixTemplate: 'package-retriever-index:v1:{userId}:',
		},
	] as const

export const accountUserOwnedR2Surfaces: ReadonlyArray<UserOwnedR2Surface> = [
	{
		id: 'email_raw_mime',
		binding: 'EMAIL_BLOBS',
		sourceTable: 'email_messages',
		sourceColumn: 'id',
		keyTemplate: 'email-raw:v1:{userId}/{messageId}',
		notes: 'Canonical key generated by emailRawMimeKey.',
	},
	{
		id: 'email_attachment_storage_key',
		binding: 'EMAIL_BLOBS',
		sourceTable: 'email_attachments',
		sourceColumn: 'storage_key',
		keyTemplate: 'email-attachment:v1:{userId}/{messageId}/{attachmentId}',
	},
	{
		id: 'community_icon',
		binding: 'COMMUNITY_ASSETS',
		sourceTable: 'community_listings',
		keyTemplate: 'community-icon:v1/{listingId}/{commit}/asset',
	},
	{
		id: 'user_avatar',
		binding: 'COMMUNITY_ASSETS',
		sourceTable: 'users',
		sourceColumn: 'avatar_key',
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
	Record<'mcp' | 'repo_session' | 'package_realtime_session', string>
> = {
	mcp: 'MCP',
	repo_session: 'RepoSession',
	package_realtime_session: 'PackageRealtimeSession',
} as const

export function getAccountExportExcludedDurableObjects(): Array<{
	name: string
	reason: string
}> {
	return (
		['mcp', 'repo_session', 'package_realtime_session'] satisfies Array<
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
