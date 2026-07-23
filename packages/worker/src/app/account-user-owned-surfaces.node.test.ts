import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { expect, test } from 'vitest'
import {
	accountUserOwnedDurableObjectSurfaces,
	accountUserOwnedKvKeySchemes,
	accountUserOwnedR2Surfaces,
	accountUserOwnedVectorizeSurfaces,
	getAccountDeletionDurableObjectResultKeys,
	getAccountExportExcludedDurableObjects,
	getAccountUserOwnedSurfaceCoverage,
} from './account-user-owned-surfaces.ts'

const accountDeletionSource = readFileSync(
	fileURLToPath(new URL('./account-deletion.ts', import.meta.url)),
	'utf8',
)
const accountExportSource = readFileSync(
	fileURLToPath(new URL('./account-export.ts', import.meta.url)),
	'utf8',
)
const manifestCacheSource = readFileSync(
	fileURLToPath(
		new URL('../package-retrievers/manifest-cache.ts', import.meta.url),
	),
	'utf8',
)

test('account export excluded durable objects preserve the legacy manifest list', () => {
	expect(getAccountExportExcludedDurableObjects()).toEqual([
		{
			name: 'MCP',
			reason:
				'Session-keyed by the MCP SDK and not globally enumerable; durable user data is carried by D1 and user-scoped stores instead.',
		},
		{
			name: 'RepoSession',
			reason:
				'Ephemeral editing workspace. Canonical repo-backed source is exported as Artifacts repo pointers via entity_sources and repo_sessions metadata.',
		},
		{
			name: 'PackageRealtimeSession',
			reason:
				'Ephemeral live websocket/session state. Durable app storage is exported through StorageRunner buckets.',
		},
	])
})

test('account deletion durable object result keys are declared by the registry', () => {
	expect([...getAccountDeletionDurableObjectResultKeys()].sort()).toEqual([
		'jobManagers',
		'mcpAgentSessions',
		'mcpClientHubs',
		'packageRealtimeSessions',
		'packageServiceInstances',
		'remoteConnectorSessions',
		'repoSessions',
		'storageRunners',
	])
})

test('account user-owned surface registry covers known out-of-band surfaces', () => {
	const coverage = getAccountUserOwnedSurfaceCoverage()
	expect([...coverage.durableObjectIds].sort()).toEqual([
		'job_manager',
		'mcp',
		'mcp_client_hub',
		'package_realtime_session',
		'package_service_instance',
		'remote_connector_session',
		'repo_session',
		'storage_runner',
	])
	expect([...coverage.vectorizeIds].sort()).toEqual([
		'job',
		'memory',
		'saved_package',
	])
	expect([...coverage.kvSchemeIds].sort()).toEqual([
		'community_icon_derived_cache',
		'community_snapshot',
		'package_retriever_index_entry',
		'package_retriever_index_prefix',
		'package_retriever_manifest',
		'published_bundle_artifact_kv_key',
		'source_manifest_snapshot',
		'source_snapshot',
		'usage_rollup_derived_cache',
	])
	expect([...coverage.r2SurfaceIds].sort()).toEqual([
		'community_icon',
		'email_attachment_storage_key',
		'email_raw_mime',
		'user_avatar',
	])
	expect([...coverage.artifactSurfaceIds].sort()).toEqual([
		'entity_sources',
		'repo_sessions',
	])
})

test('vectorize surfaces cover derived memory, job, and package vectors', () => {
	expect(
		accountUserOwnedVectorizeSurfaces.map((surface) => surface.sourceTable),
	).toEqual(['mcp_memories', 'jobs', 'saved_packages'])
	expect(
		accountUserOwnedVectorizeSurfaces.every(
			(surface) => surface.export === 'rebuild_from_d1',
		),
	).toBe(true)
})

test('KV key schemes include account deletion prefix guardrails', () => {
	const prefixes = accountUserOwnedKvKeySchemes.map(
		(scheme) => scheme.prefixTemplate,
	)
	expect(prefixes).toEqual(
		expect.arrayContaining([
			'source-snapshot:v1:{sourceId}:',
			'source-manifest-snapshot:v1:{sourceId}:',
			'package-retriever-index:v1:{userId}:',
		]),
	)
})

test('R2 surfaces cover email blobs, community icons, and user avatars', () => {
	expect(accountUserOwnedR2Surfaces).toEqual(
		expect.arrayContaining([
			expect.objectContaining({
				id: 'email_raw_mime',
				binding: 'EMAIL_BLOBS',
			}),
			expect.objectContaining({
				id: 'email_attachment_storage_key',
				binding: 'EMAIL_BLOBS',
			}),
			expect.objectContaining({
				id: 'community_icon',
				binding: 'COMMUNITY_ASSETS',
			}),
			expect.objectContaining({
				id: 'user_avatar',
				binding: 'COMMUNITY_ASSETS',
			}),
		]),
	)
	expect(
		accountUserOwnedR2Surfaces.every(
			(surface) => surface.export === 'chunked_bytes',
		),
	).toBe(true)
})

test('account deletion and export consume the out-of-band surface registry', () => {
	expect(accountDeletionSource).toContain(
		"from '#app/account-user-owned-surfaces.ts'",
	)
	expect(accountDeletionSource).toContain(
		'getAccountDeletionDurableObjectResultKeys',
	)
	expect(accountDeletionSource).toContain('accountUserOwnedVectorizeSurfaces')
	expect(accountDeletionSource).toContain('deleteAccountCommunityAssetPrefixes')
	expect(accountExportSource).toContain(
		'getAccountExportExcludedDurableObjects',
	)
	expect(accountExportSource).toContain('readAccountR2ExportPage')
	expect(accountExportSource).not.toContain('collectAccountR2Inventory')

	for (const prefix of [
		'source-snapshot:v1:',
		'source-manifest-snapshot:v1:',
	]) {
		expect(
			accountUserOwnedKvKeySchemes.some((scheme) =>
				scheme.prefixTemplate?.includes(prefix),
			),
			`KV scheme registry missing prefix ${prefix}`,
		).toBe(true)
		expect(
			accountDeletionSource.includes(prefix),
			`account-deletion.ts must still enumerate prefix ${prefix}`,
		).toBe(true)
	}
	expect(manifestCacheSource).toContain('legacyRetrieverScopeIndexPrefix')
	expect(manifestCacheSource).toContain(
		'deleteLegacyPackageRetrieverScopeIndexes',
	)

	for (const surface of accountUserOwnedDurableObjectSurfaces) {
		if (surface.deletionResultKey == null) continue
		expect(
			accountDeletionSource.includes(surface.deletionResultKey),
			`account-deletion.ts missing clearedDurableObjects key ${surface.deletionResultKey}`,
		).toBe(true)
	}
})
