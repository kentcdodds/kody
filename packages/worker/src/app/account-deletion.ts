import { getErrorMessage } from '@kody-internal/shared/error-message.ts'
import { storageRunnerRpc } from '#worker/storage-runner.ts'
import { purgeJobManagerForUser } from '#worker/jobs/manager-client.ts'
import { jobVectorId } from '#mcp/jobs-vectorize.ts'
import { memoryVectorId } from '#mcp/memory/memory-vectorize.ts'
import { savedPackageVectorId } from '#worker/package-registry/repo.ts'
import { getCapabilityVectorIndex } from '#mcp/capabilities/capability-search.ts'
import { cleanupAllUserArtifactRepos } from '#worker/repo/artifact-repo-cleanup.ts'
import { repoSessionRpc } from '#worker/repo/repo-session-rpc.ts'
import { userScopedConnectorSessionKey } from '#worker/remote-connector/connector-session-key.ts'
import { mcpClientHubDurableObjectName } from '#worker/user-scoped-durable-object-name.ts'
import {
	buildPackageServiceStorageId,
	packageServiceRpc,
} from '#worker/package-runtime/package-service.ts'
import { packageRealtimeSessionRpc } from '#worker/package-runtime/realtime-session.ts'
import {
	accountUserDataTargets,
	getAccountD1UserColumnCoverage,
} from '#app/account-data-targets.ts'
import {
	buildPublishedSourceManifestSnapshotKvKey,
	buildPublishedSourceSnapshotKvKey,
} from '#worker/package-runtime/published-runtime-artifacts.ts'
import { deleteAllPackageRetrieverCacheEntriesForUser } from '#worker/package-retrievers/manifest-cache.ts'
import { buildCommunitySnapshotKvKey } from '#worker/community/snapshot.ts'
import {
	buildCommunityIconCacheKey,
	buildCommunityIconR2Key,
} from '#worker/community/community-icon.ts'
import { derivedCacheKeyPrefix } from '#worker/kv-cachified.ts'
import { emailRawMimeKey } from '#worker/email/repo.ts'

// Imported manually instead of via `@cloudflare/workers-oauth-provider` so
// node-only unit tests can require this module without dragging in
// `cloudflare:workers` (the OAuth provider package re-exports through that
// runtime symbol). The shape mirrors the subset of OAuthHelpers we use.
type OAuthGrantPage = {
	items: Array<{ id: string; clientId: string }>
	cursor: string | undefined
}
type OAuthHelpersShape = {
	listUserGrants(
		userId: string,
		options: { cursor: string | undefined },
	): Promise<OAuthGrantPage>
	revokeGrant(grantId: string, userId: string): Promise<unknown>
}

type AccountDeletionEnv = Env & {
	OAUTH_PROVIDER?: OAuthHelpersShape
}

export type AccountDeletionResult = {
	deletedRowCounts: Record<string, number>
	updatedRowCounts: Record<string, number>
	deletedKvKeys: number
	deletedCommunityAssets: number
	deletedEmailBlobs: number
	deletedArtifactRepos: number
	revokedOAuthGrants: number
	clearedDurableObjects: Record<string, number>
	deletedVectors: number
	warnings: Array<string>
}

export function getAccountDeletionD1UserColumnCoverage() {
	return getAccountD1UserColumnCoverage()
}

type UserSourceSnapshot = {
	sourceId: string
	publishedCommit: string | null
}

type UserSavedPackageSnapshot = {
	id: string
	kodyId: string
	sourceId: string
	hasApp: boolean
}

type UserRepoSessionSnapshot = {
	id: string
}

type UserRemoteConnectorSnapshot = {
	instanceId: string
}

type UserMcpServerSnapshot = {
	id: string
}

type UserPackageServiceSnapshot = {
	packageId: string
	kodyId: string
	sourceId: string
	serviceName: string
}

type UserCommunityListingSnapshot = {
	id: string
	pinnedCommit: string
	iconCommit: string
}

type UserDeletionInventory = {
	vectorIds: Array<string>
	storageIds: Array<string>
	bundleKvKeys: Array<string>
	emailBlobKeys: Array<string>
	sourceSnapshots: Array<UserSourceSnapshot>
	savedPackages: Array<UserSavedPackageSnapshot>
	repoSessions: Array<UserRepoSessionSnapshot>
	remoteConnectors: Array<UserRemoteConnectorSnapshot>
	mcpServers: Array<UserMcpServerSnapshot>
	packageServices: Array<UserPackageServiceSnapshot>
	communityListings: Array<UserCommunityListingSnapshot>
	avatarR2Key: string | null
}

function uniqueStrings(values: Iterable<string | null | undefined>) {
	return Array.from(
		new Set(
			Array.from(values)
				.map((value) => value?.trim() ?? '')
				.filter((value) => value.length > 0),
		),
	)
}

async function listUserVectorIds(env: Env, userId: string) {
	const memoryRows = await env.APP_DB.prepare(
		`SELECT id FROM mcp_memories WHERE user_id = ?`,
	)
		.bind(userId)
		.all<{ id: string }>()
	const jobRows = await env.APP_DB.prepare(
		`SELECT id FROM jobs WHERE user_id = ?`,
	)
		.bind(userId)
		.all<{ id: string }>()
	const packageRows = await env.APP_DB.prepare(
		`SELECT id FROM saved_packages WHERE user_id = ?`,
	)
		.bind(userId)
		.all<{ id: string }>()
	const ids: Array<string> = []
	for (const row of memoryRows.results ?? []) {
		ids.push(memoryVectorId(row.id))
	}
	for (const row of jobRows.results ?? []) {
		ids.push(jobVectorId(row.id))
	}
	for (const row of packageRows.results ?? []) {
		ids.push(savedPackageVectorId(row.id))
	}
	return ids
}

async function listUserStorageIds(env: Env, userId: string) {
	const [jobRows, archivedRows, runtimeRows, packageRows, serviceRows] =
		await Promise.all([
			env.APP_DB.prepare(
				`SELECT storage_id FROM jobs WHERE user_id = ? AND storage_id IS NOT NULL`,
			)
				.bind(userId)
				.all<{ storage_id: string }>(),
			env.APP_DB.prepare(
				`SELECT storage_id FROM archived_job_artifacts WHERE user_id = ? AND storage_id IS NOT NULL`,
			)
				.bind(userId)
				.all<{ storage_id: string }>(),
			env.APP_DB.prepare(
				`SELECT storage_id FROM package_runtime_runs WHERE user_id = ? AND storage_id IS NOT NULL`,
			)
				.bind(userId)
				.all<{ storage_id: string }>(),
			env.APP_DB.prepare(
				`SELECT id FROM saved_packages WHERE user_id = ? AND has_app = 1`,
			)
				.bind(userId)
				.all<{ id: string }>(),
			env.APP_DB.prepare(
				`SELECT DISTINCT package_id, name
				FROM package_runtime_runs
				WHERE user_id = ? AND surface = 'service' AND name IS NOT NULL`,
			)
				.bind(userId)
				.all<{ package_id: string; name: string }>(),
		])
	return uniqueStrings([
		...(jobRows.results ?? []).map((row) => row.storage_id),
		...(archivedRows.results ?? []).map((row) => row.storage_id),
		...(runtimeRows.results ?? []).map((row) => row.storage_id),
		...(packageRows.results ?? []).map((row) => row.id),
		...(serviceRows.results ?? []).map((row) =>
			buildPackageServiceStorageId(row.package_id, row.name),
		),
	])
}

async function listUserSourceSnapshots(env: Env, userId: string) {
	const sourceRows = await env.APP_DB.prepare(
		`SELECT id, published_commit
		FROM entity_sources
		WHERE user_id = ?`,
	)
		.bind(userId)
		.all<{ id: string; published_commit: string | null }>()
	return (sourceRows.results ?? []).map((row) => ({
		sourceId: row.id,
		publishedCommit: row.published_commit,
	}))
}

async function listUserSavedPackages(env: Env, userId: string) {
	const rows = await env.APP_DB.prepare(
		`SELECT id, kody_id, source_id, has_app
		FROM saved_packages
		WHERE user_id = ?`,
	)
		.bind(userId)
		.all<{
			id: string
			kody_id: string
			source_id: string
			has_app: number | string | boolean
		}>()
	return (rows.results ?? []).map((row) => ({
		id: row.id,
		kodyId: row.kody_id,
		sourceId: row.source_id,
		hasApp: row.has_app === 1 || row.has_app === '1' || row.has_app === true,
	}))
}

async function listUserRepoSessions(env: Env, userId: string) {
	const rows = await env.APP_DB.prepare(
		`SELECT id FROM repo_sessions WHERE user_id = ?`,
	)
		.bind(userId)
		.all<{ id: string }>()
	return (rows.results ?? []).map((row) => ({ id: row.id }))
}

async function listUserRemoteConnectors(env: Env, userId: string) {
	const rows = await env.APP_DB.prepare(
		`SELECT instance_id
		FROM remote_connector_settings
		WHERE user_id = ?`,
	)
		.bind(userId)
		.all<{ instance_id: string }>()
	return (rows.results ?? []).map((row) => ({
		instanceId: row.instance_id,
	}))
}

async function listUserMcpServers(env: Env, userId: string) {
	const rows = await env.APP_DB.prepare(
		`SELECT id
		FROM mcp_server_settings
		WHERE user_id = ?`,
	)
		.bind(userId)
		.all<{ id: string }>()
	return (rows.results ?? []).map((row) => ({ id: row.id }))
}

async function listUserPackageServices(env: Env, userId: string) {
	const rows = await env.APP_DB.prepare(
		`SELECT DISTINCT
			r.package_id,
			COALESCE(p.kody_id, r.package_kody_id) AS kody_id,
			COALESCE(p.source_id, r.source_id) AS source_id,
			r.name
		FROM package_runtime_runs AS r
		LEFT JOIN saved_packages AS p
			ON p.id = r.package_id AND p.user_id = r.user_id
		WHERE r.user_id = ?
			AND r.surface = 'service'
			AND r.name IS NOT NULL`,
	)
		.bind(userId)
		.all<{
			package_id: string
			kody_id: string
			source_id: string | null
			name: string
		}>()
	return (rows.results ?? []).map((row) => ({
		packageId: row.package_id,
		kodyId: row.kody_id,
		sourceId: row.source_id ?? '',
		serviceName: row.name,
	}))
}

async function listUserEmailBlobKeys(env: Env, userId: string) {
	const [rawMimeRows, attachmentRows] = await Promise.all([
		// Deterministic canonical keys for every message id.
		env.APP_DB.prepare(
			`SELECT id
			FROM email_messages
			WHERE user_id = ?`,
		)
			.bind(userId)
			.all<{ id: string }>(),
		// Externally stored attachments (outbound mail) have their own R2
		// objects, separate from any raw-MIME blob.
		env.APP_DB.prepare(
			`SELECT attachment.storage_key AS storage_key
			FROM email_attachments attachment
			JOIN email_messages message ON message.id = attachment.message_id
			WHERE message.user_id = ? AND attachment.storage_key IS NOT NULL`,
		)
			.bind(userId)
			.all<{ storage_key: string }>(),
	])
	return uniqueStrings([
		...(rawMimeRows.results ?? []).map((row) =>
			emailRawMimeKey(userId, row.id),
		),
		...(attachmentRows.results ?? []).map((row) => row.storage_key),
	])
}

async function listUserCommunityListings(env: Env, userId: string) {
	const rows = await env.APP_DB.prepare(
		`SELECT community_listings.id, community_listings.pinned_commit,
			entity_sources.published_commit AS source_published_commit
		FROM community_listings
		LEFT JOIN entity_sources
			ON entity_sources.id = community_listings.source_id
			AND entity_sources.user_id = community_listings.owner_user_id
			AND entity_sources.entity_kind = 'package'
			AND entity_sources.entity_id = community_listings.package_id
		WHERE community_listings.owner_user_id = ?`,
	)
		.bind(userId)
		.all<{
			id: string
			pinned_commit: string
			source_published_commit: string | null
		}>()
	return (rows.results ?? []).map((row) => ({
		id: row.id,
		pinnedCommit: row.pinned_commit,
		iconCommit: row.source_published_commit ?? row.pinned_commit,
	}))
}

async function listUserBundleKvKeys(input: {
	env: Env
	userId: string
	sourceSnapshots: ReadonlyArray<UserSourceSnapshot>
	communityListings: ReadonlyArray<UserCommunityListingSnapshot>
}) {
	const published = await input.env.APP_DB.prepare(
		`SELECT kv_key FROM published_bundle_artifacts WHERE user_id = ?`,
	)
		.bind(input.userId)
		.all<{ kv_key: string }>()
	return uniqueStrings([
		...(published.results ?? []).map((row) => row.kv_key),
		...input.sourceSnapshots.flatMap((source) =>
			source.publishedCommit
				? [
						buildPublishedSourceSnapshotKvKey({
							sourceId: source.sourceId,
							publishedCommit: source.publishedCommit,
						}),
						buildPublishedSourceManifestSnapshotKvKey({
							sourceId: source.sourceId,
							publishedCommit: source.publishedCommit,
						}),
					]
				: [],
		),
		...input.communityListings.flatMap((listing) => [
			buildCommunitySnapshotKvKey(listing.id),
			derivedCacheKeyPrefix +
				buildCommunityIconCacheKey({
					listingId: listing.id,
					commit: listing.pinnedCommit,
				}),
			derivedCacheKeyPrefix +
				buildCommunityIconCacheKey({
					listingId: listing.id,
					commit: listing.iconCommit,
				}),
		]),
	])
}

async function listUserAvatarR2Key(
	env: Env,
	dbUserId: number,
): Promise<string | null> {
	const row = await env.APP_DB.prepare(
		`SELECT avatar_key FROM users WHERE id = ?`,
	)
		.bind(dbUserId)
		.first<{ avatar_key: string | null }>()
	return row?.avatar_key == null ? null : String(row.avatar_key)
}

async function collectUserDeletionInventory(input: {
	env: Env
	userId: string
	dbUserId: number
	warnings: Array<string>
}): Promise<UserDeletionInventory> {
	const [
		vectorIds,
		storageIds,
		emailBlobKeys,
		sourceSnapshots,
		savedPackages,
		repoSessions,
		remoteConnectors,
		mcpServers,
		packageServices,
		communityListings,
		avatarR2Key,
	] = await Promise.all([
		listUserVectorIds(input.env, input.userId).catch((error) => {
			const message = getErrorMessage(error)
			input.warnings.push(`Failed to enumerate vector ids: ${message}`)
			return [] as Array<string>
		}),
		listUserStorageIds(input.env, input.userId).catch((error) => {
			const message = getErrorMessage(error)
			input.warnings.push(`Failed to enumerate storage ids: ${message}`)
			return [] as Array<string>
		}),
		listUserEmailBlobKeys(input.env, input.userId).catch((error) => {
			const message = getErrorMessage(error)
			input.warnings.push(`Failed to enumerate email blob keys: ${message}`)
			return [] as Array<string>
		}),
		listUserSourceSnapshots(input.env, input.userId).catch((error) => {
			const message = getErrorMessage(error)
			input.warnings.push(`Failed to enumerate source snapshots: ${message}`)
			return [] as Array<UserSourceSnapshot>
		}),
		listUserSavedPackages(input.env, input.userId).catch((error) => {
			const message = getErrorMessage(error)
			input.warnings.push(`Failed to enumerate saved packages: ${message}`)
			return [] as Array<UserSavedPackageSnapshot>
		}),
		listUserRepoSessions(input.env, input.userId).catch((error) => {
			const message = getErrorMessage(error)
			input.warnings.push(`Failed to enumerate repo sessions: ${message}`)
			return [] as Array<UserRepoSessionSnapshot>
		}),
		listUserRemoteConnectors(input.env, input.userId).catch((error) => {
			const message = getErrorMessage(error)
			input.warnings.push(`Failed to enumerate remote connectors: ${message}`)
			return [] as Array<UserRemoteConnectorSnapshot>
		}),
		listUserMcpServers(input.env, input.userId).catch((error) => {
			const message = getErrorMessage(error)
			input.warnings.push(`Failed to enumerate MCP servers: ${message}`)
			return [] as Array<UserMcpServerSnapshot>
		}),
		listUserPackageServices(input.env, input.userId).catch((error) => {
			const message = getErrorMessage(error)
			input.warnings.push(`Failed to enumerate package services: ${message}`)
			return [] as Array<UserPackageServiceSnapshot>
		}),
		listUserCommunityListings(input.env, input.userId).catch((error) => {
			const message = getErrorMessage(error)
			input.warnings.push(`Failed to enumerate community listings: ${message}`)
			return [] as Array<UserCommunityListingSnapshot>
		}),
		listUserAvatarR2Key(input.env, input.dbUserId).catch((error) => {
			const message = getErrorMessage(error)
			input.warnings.push(`Failed to enumerate user avatar key: ${message}`)
			return null as string | null
		}),
	])
	const bundleKvKeys = await listUserBundleKvKeys({
		env: input.env,
		userId: input.userId,
		sourceSnapshots,
		communityListings,
	}).catch((error) => {
		const message = getErrorMessage(error)
		input.warnings.push(`Failed to enumerate bundle KV keys: ${message}`)
		return [] as Array<string>
	})
	return {
		vectorIds,
		storageIds,
		bundleKvKeys,
		emailBlobKeys,
		sourceSnapshots,
		savedPackages,
		repoSessions,
		remoteConnectors,
		mcpServers,
		packageServices,
		communityListings,
		avatarR2Key,
	}
}

async function revokeAllOAuthGrants(input: {
	helpers: OAuthHelpersShape
	userId: string
	warnings: Array<string>
}): Promise<number> {
	// Both the page listing and the individual revoke calls can throw, and
	// neither failure should abort the larger account-deletion cascade -
	// the rest of the steps still need to run so the user's data is
	// removed even if the OAuth provider is briefly unavailable.
	let cursor: string | undefined
	let revoked = 0
	while (true) {
		let page: Awaited<ReturnType<OAuthHelpersShape['listUserGrants']>>
		try {
			page = await input.helpers.listUserGrants(input.userId, { cursor })
		} catch (error) {
			const message = getErrorMessage(error)
			input.warnings.push(
				`OAuth grant listing failed; revoked ${revoked} grant(s) before the failure: ${message}`,
			)
			return revoked
		}
		for (const grant of page.items) {
			try {
				await input.helpers.revokeGrant(grant.id, input.userId)
				revoked += 1
			} catch (error) {
				const message = getErrorMessage(error)
				input.warnings.push(
					`OAuth grant revoke failed for grant ${grant.id}: ${message}`,
				)
			}
		}
		if (!page.cursor) return revoked
		cursor = page.cursor
	}
}

async function clearStorageRunners(input: {
	env: Env
	userId: string
	storageIds: ReadonlyArray<string>
	warnings: Array<string>
}): Promise<number> {
	let cleared = 0
	for (const storageId of input.storageIds) {
		try {
			const stub = storageRunnerRpc({
				env: input.env,
				userId: input.userId,
				storageId,
			})
			await stub.clearStorage()
			cleared += 1
		} catch (error) {
			const message = getErrorMessage(error)
			input.warnings.push(
				`Storage runner clear failed for ${storageId}: ${message}`,
			)
		}
	}
	return cleared
}

async function purgeJobManager(input: {
	env: Env
	userId: string
	warnings: Array<string>
}): Promise<number> {
	try {
		const result = await purgeJobManagerForUser({
			env: input.env,
			userId: input.userId,
		})
		if (!result.purged) {
			input.warnings.push(
				'JOB_MANAGER binding was unavailable; the user scheduler Durable Object was not purged.',
			)
		}
		return result.purged ? 1 : 0
	} catch (error) {
		const message = getErrorMessage(error)
		input.warnings.push(`Job manager purge failed: ${message}`)
		return 0
	}
}

async function purgeRepoSessions(input: {
	env: Env
	userId: string
	sessions: ReadonlyArray<UserRepoSessionSnapshot>
	warnings: Array<string>
}): Promise<number> {
	let purged = 0
	for (const session of input.sessions) {
		try {
			await repoSessionRpc(input.env, session.id).purgeSession({
				sessionId: session.id,
				userId: input.userId,
			})
			purged += 1
		} catch (error) {
			const message = getErrorMessage(error)
			input.warnings.push(
				`Repo session purge failed for ${session.id}: ${message}`,
			)
		}
	}
	return purged
}

async function purgeRemoteConnectorSessions(input: {
	env: Env
	userId: string
	connectors: ReadonlyArray<UserRemoteConnectorSnapshot>
	warnings: Array<string>
}): Promise<number> {
	const namespace = input.env.REMOTE_CONNECTOR_SESSION
	if (!namespace) {
		if (input.connectors.length > 0) {
			input.warnings.push(
				`REMOTE_CONNECTOR_SESSION binding was unavailable; ${input.connectors.length} connector session(s) were not purged.`,
			)
		}
		return 0
	}
	let purged = 0
	for (const connector of input.connectors) {
		const sessionKey = userScopedConnectorSessionKey({
			userId: input.userId,
			instanceId: connector.instanceId,
		})
		try {
			const stub = namespace.get(
				namespace.idFromName(sessionKey),
			) as unknown as {
				rpcPurgeUserSession: (payload: {
					userId: string
					instanceId: string
				}) => Promise<{ ok: true }>
			}
			await stub.rpcPurgeUserSession({
				userId: input.userId,
				instanceId: connector.instanceId,
			})
			purged += 1
		} catch (error) {
			const message = getErrorMessage(error)
			input.warnings.push(
				`Remote connector session purge failed for ${connector.instanceId}: ${message}`,
			)
		}
	}
	return purged
}

async function purgeMcpClientHub(input: {
	env: Env
	userId: string
	warnings: Array<string>
}): Promise<number> {
	// Always purge, even when no mcp_server_settings rows remain: the hub DO
	// can still hold OAuth tokens and SDK registrations (for example after a
	// failed add), and those must not survive account deletion.
	const namespace = input.env.MCP_CLIENT_HUB
	if (!namespace) {
		input.warnings.push(
			'MCP_CLIENT_HUB binding was unavailable; the MCP client hub was not purged.',
		)
		return 0
	}
	try {
		const stub = namespace.get(
			namespace.idFromName(mcpClientHubDurableObjectName(input.userId)),
		) as unknown as {
			purgeForAccountDeletion: () => Promise<void>
		}
		await stub.purgeForAccountDeletion()
		return 1
	} catch (error) {
		const message = getErrorMessage(error)
		input.warnings.push(`MCP client hub purge failed: ${message}`)
		return 0
	}
}

async function purgePackageRealtimeSessions(input: {
	env: Env
	userId: string
	packages: ReadonlyArray<UserSavedPackageSnapshot>
	warnings: Array<string>
}): Promise<number> {
	let purged = 0
	for (const savedPackage of input.packages.filter((pkg) => pkg.hasApp)) {
		try {
			await packageRealtimeSessionRpc({
				env: input.env,
				userId: input.userId,
				packageId: savedPackage.id,
				kodyId: savedPackage.kodyId,
				sourceId: savedPackage.sourceId,
				baseUrl: 'https://account-deletion.invalid',
			}).purge()
			purged += 1
		} catch (error) {
			const message = getErrorMessage(error)
			input.warnings.push(
				`Package realtime session purge failed for ${savedPackage.id}: ${message}`,
			)
		}
	}
	return purged
}

async function purgePackageServices(input: {
	env: Env
	userId: string
	services: ReadonlyArray<UserPackageServiceSnapshot>
	warnings: Array<string>
}): Promise<number> {
	let purged = 0
	for (const service of input.services) {
		try {
			await packageServiceRpc({
				env: input.env,
				userId: input.userId,
				packageId: service.packageId,
				kodyId: service.kodyId,
				sourceId: service.sourceId,
				baseUrl: 'https://account-deletion.invalid',
				serviceName: service.serviceName,
			}).purge()
			purged += 1
		} catch (error) {
			const message = getErrorMessage(error)
			input.warnings.push(
				`Package service purge failed for ${service.packageId}/${service.serviceName}: ${message}`,
			)
		}
	}
	return purged
}

async function deleteVectorsByIds(input: {
	env: Env
	ids: ReadonlyArray<string>
	warnings: Array<string>
}): Promise<number> {
	if (input.ids.length === 0) return 0
	const index = getCapabilityVectorIndex(input.env)
	if (!index) return 0
	let deleted = 0
	const batchSize = 100
	for (let offset = 0; offset < input.ids.length; offset += batchSize) {
		const batch = input.ids.slice(offset, offset + batchSize)
		try {
			await index.deleteByIds(batch)
			deleted += batch.length
		} catch (error) {
			const message = getErrorMessage(error)
			input.warnings.push(`Vectorize deleteByIds batch failed: ${message}`)
		}
	}
	return deleted
}

async function deleteKvKeys(input: {
	kv: KVNamespace
	keys: ReadonlyArray<string>
	warnings: Array<string>
}): Promise<number> {
	let deleted = 0
	for (const key of input.keys) {
		try {
			await input.kv.delete(key)
			deleted += 1
		} catch (error) {
			const message = getErrorMessage(error)
			input.warnings.push(`KV delete failed for ${key}: ${message}`)
		}
	}
	return deleted
}

async function deleteR2Objects(input: {
	blobs: R2Bucket
	keys: ReadonlyArray<string>
	label: string
	warnings: Array<string>
}): Promise<number> {
	let deleted = 0
	for (const key of input.keys) {
		try {
			await input.blobs.delete(key)
			deleted += 1
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error)
			input.warnings.push(`${input.label} delete failed for ${key}: ${message}`)
		}
	}
	return deleted
}

async function listKvKeysByPrefix(input: {
	kv: KVNamespace
	prefixes: ReadonlyArray<string>
	warnings: Array<string>
}) {
	const keys = new Set<string>()
	if (typeof input.kv.list !== 'function') return keys
	for (const prefix of input.prefixes) {
		let cursor: string | undefined
		do {
			try {
				const result = await input.kv.list({
					prefix,
					cursor,
				})
				for (const key of result.keys) {
					keys.add(key.name)
				}
				cursor = result.list_complete ? undefined : result.cursor
			} catch (error) {
				const message = getErrorMessage(error)
				input.warnings.push(
					`KV prefix listing failed for ${prefix}: ${message}`,
				)
				cursor = undefined
			}
		} while (cursor)
	}
	return keys
}

async function deleteRetrieverCache(input: {
	env: Env
	userId: string
	packageIds: ReadonlyArray<string>
	warnings: Array<string>
}) {
	try {
		return await deleteAllPackageRetrieverCacheEntriesForUser({
			env: input.env,
			userId: input.userId,
			packageIds: input.packageIds,
		})
	} catch (error) {
		const message = getErrorMessage(error)
		input.warnings.push(`Package retriever KV cleanup failed: ${message}`)
		return 0
	}
}

async function deleteUserScopedRows(input: {
	env: Env
	mcpUserId: string
	dbUserId: number
	warnings: Array<string>
}): Promise<{
	deletedRowCounts: Record<string, number>
	updatedRowCounts: Record<string, number>
}> {
	const deletedRowCounts: Record<string, number> = {}
	const updatedRowCounts: Record<string, number> = {}
	function recordDeleted(tableName: string, changes: number | undefined) {
		deletedRowCounts[tableName] =
			(deletedRowCounts[tableName] ?? 0) + (changes ?? 0)
	}
	function recordUpdated(tableName: string, changes: number | undefined) {
		updatedRowCounts[tableName] =
			(updatedRowCounts[tableName] ?? 0) + (changes ?? 0)
	}
	for (const target of accountUserDataTargets) {
		try {
			let sql: string
			let params: Array<unknown>
			let tableName: string
			switch (target.kind) {
				case 'user_id': {
					sql = `DELETE FROM ${target.table} WHERE user_id = ?`
					params = [input.mcpUserId]
					tableName = target.table
					break
				}
				case 'db_user_id': {
					sql = `DELETE FROM ${target.table} WHERE user_id = ?`
					params = [input.dbUserId]
					tableName = target.table
					break
				}
				case 'db_user_target': {
					sql = `DELETE FROM ${target.table} WHERE target = ?`
					params = [String(input.dbUserId)]
					tableName = target.table
					break
				}
				case 'user_columns': {
					sql = `DELETE FROM ${target.table} WHERE ${target.columns
						.map((column) => `${column} = ?`)
						.join(' OR ')}`
					params = target.columns.map(() => input.mcpUserId)
					tableName = target.table
					break
				}
				case 'null_user_column': {
					sql = `UPDATE ${target.table}
						SET ${target.nullColumns.map((column) => `${column} = NULL`).join(', ')}
						WHERE ${target.matchColumn} = ?`
					params = [input.mcpUserId]
					tableName = target.table
					break
				}
				case 'replace_user_column': {
					sql = `UPDATE ${target.table}
						SET ${target.setColumn} = ?
						WHERE ${target.matchColumn} = ?`
					params = [target.value, input.mcpUserId]
					tableName = target.table
					break
				}
				case 'bucket_parent': {
					sql = `DELETE FROM ${target.table} WHERE bucket_id IN (
						SELECT id FROM ${target.parentTable} WHERE user_id = ?
					)`
					params = [input.mcpUserId]
					tableName = target.table
					break
				}
				case 'attachment_parent': {
					sql = `DELETE FROM email_attachments WHERE message_id IN (
						SELECT id FROM email_messages WHERE user_id = ?
					)`
					params = [input.mcpUserId]
					tableName = 'email_attachments'
					break
				}
				case 'community_listing_child': {
					sql = `DELETE FROM ${target.table} WHERE ${target.listingColumn} IN (
						SELECT id FROM community_listings WHERE owner_user_id = ?
					)`
					params = [input.mcpUserId]
					tableName = target.table
					break
				}
				case 'mcp_memory_suppression': {
					sql = `DELETE FROM mcp_memory_conversation_suppressions WHERE user_id = ?`
					params = [input.mcpUserId]
					tableName = 'mcp_memory_conversation_suppressions'
					break
				}
				default: {
					const exhaustive: never = target
					throw new Error(
						`Unhandled user-scoped delete target: ${JSON.stringify(exhaustive)}`,
					)
				}
			}
			const result = await input.env.APP_DB.prepare(sql)
				.bind(...params)
				.run()
			if (
				target.kind === 'null_user_column' ||
				target.kind === 'replace_user_column'
			) {
				recordUpdated(tableName, result.meta.changes)
			} else {
				recordDeleted(tableName, result.meta.changes)
			}
		} catch (error) {
			const message = getErrorMessage(error)
			const targetLabel =
				target.kind === 'mcp_memory_suppression'
					? 'mcp_memory_conversation_suppressions'
					: target.table
			input.warnings.push(`Failed to delete from ${targetLabel}: ${message}`)
			if (
				target.kind === 'null_user_column' ||
				target.kind === 'replace_user_column'
			) {
				recordUpdated(targetLabel, 0)
			} else {
				recordDeleted(targetLabel, 0)
			}
		}
	}
	return { deletedRowCounts, updatedRowCounts }
}

async function deleteUserRow(input: {
	env: Env
	dbUserId: number
	warnings: Array<string>
}): Promise<number> {
	try {
		const result = await input.env.APP_DB.prepare(
			`DELETE FROM users WHERE id = ?`,
		)
			.bind(input.dbUserId)
			.run()
		return result.meta.changes ?? 0
	} catch (error) {
		const message = getErrorMessage(error)
		input.warnings.push(`Failed to delete user row: ${message}`)
		return 0
	}
}

/**
 * Orchestrate a full per-user data cleanup. The caller is responsible for
 * verifying the user's identity before invoking this; the orchestrator does
 * not re-authenticate.
 *
 * The cleanup ordering is:
 *   1. Pre-collect identifiers we need (vector ids, storage ids, KV keys,
 *      repo/session/package ids) while their owning rows still exist.
 *   2. Best-effort destructive cleanup of out-of-band stores (Vectorize,
 *      Artifacts repos, Durable Objects, KV) - each batch records a warning on
 *      failure but does not abort the cascade.
 *   3. Delete user-scoped D1 rows in dependency-safe order.
 *   4. Revoke OAuth grants and delete the user's row last so a partially
 *      failed run can be retried with the same email.
 */
export async function deleteUserAccount(input: {
	env: AccountDeletionEnv
	dbUserId: number
	mcpUserId: string
}): Promise<AccountDeletionResult> {
	const warnings: Array<string> = []
	const result: AccountDeletionResult = {
		deletedRowCounts: {},
		updatedRowCounts: {},
		deletedKvKeys: 0,
		deletedCommunityAssets: 0,
		deletedEmailBlobs: 0,
		deletedArtifactRepos: 0,
		revokedOAuthGrants: 0,
		clearedDurableObjects: {},
		deletedVectors: 0,
		warnings,
	}

	const inventory = await collectUserDeletionInventory({
		env: input.env,
		userId: input.mcpUserId,
		dbUserId: input.dbUserId,
		warnings,
	})

	result.deletedVectors = await deleteVectorsByIds({
		env: input.env,
		ids: inventory.vectorIds,
		warnings,
	})

	result.deletedArtifactRepos = await cleanupAllUserArtifactRepos({
		env: input.env,
		userId: input.mcpUserId,
		warnings,
	}).catch((error) => {
		const message = getErrorMessage(error)
		warnings.push(`Artifact repo cleanup failed unexpectedly: ${message}`)
		return 0
	})

	result.clearedDurableObjects.jobManagers = await purgeJobManager({
		env: input.env,
		userId: input.mcpUserId,
		warnings,
	})
	result.clearedDurableObjects.repoSessions = await purgeRepoSessions({
		env: input.env,
		userId: input.mcpUserId,
		sessions: inventory.repoSessions,
		warnings,
	})
	result.clearedDurableObjects.remoteConnectorSessions =
		await purgeRemoteConnectorSessions({
			env: input.env,
			userId: input.mcpUserId,
			connectors: inventory.remoteConnectors,
			warnings,
		})
	result.clearedDurableObjects.mcpClientHubs = await purgeMcpClientHub({
		env: input.env,
		userId: input.mcpUserId,
		warnings,
	})
	result.clearedDurableObjects.packageRealtimeSessions =
		await purgePackageRealtimeSessions({
			env: input.env,
			userId: input.mcpUserId,
			packages: inventory.savedPackages,
			warnings,
		})
	result.clearedDurableObjects.packageServiceInstances =
		await purgePackageServices({
			env: input.env,
			userId: input.mcpUserId,
			services: inventory.packageServices,
			warnings,
		})
	result.clearedDurableObjects.storageRunners = await clearStorageRunners({
		env: input.env,
		userId: input.mcpUserId,
		storageIds: inventory.storageIds,
		warnings,
	})

	if (input.env.BUNDLE_ARTIFACTS_KV) {
		const sourceSnapshotKeys = await listKvKeysByPrefix({
			kv: input.env.BUNDLE_ARTIFACTS_KV,
			prefixes: [
				...inventory.sourceSnapshots.flatMap((source) => [
					`source-snapshot:v1:${source.sourceId}:`,
					`source-manifest-snapshot:v1:${source.sourceId}:`,
				]),
				`package-retriever-index:v1:${input.mcpUserId}:`,
			],
			warnings,
		})
		result.deletedKvKeys =
			(await deleteKvKeys({
				kv: input.env.BUNDLE_ARTIFACTS_KV,
				keys: Array.from(
					new Set([...inventory.bundleKvKeys, ...sourceSnapshotKeys]),
				),
				warnings,
			})) +
			(await deleteRetrieverCache({
				env: input.env,
				userId: input.mcpUserId,
				packageIds: inventory.savedPackages.map((pkg) => pkg.id),
				warnings,
			}))
	} else if (
		inventory.bundleKvKeys.length > 0 ||
		inventory.savedPackages.length > 0
	) {
		warnings.push(
			`BUNDLE_ARTIFACTS_KV binding was unavailable; ${inventory.bundleKvKeys.length} bundle/source/community key(s) and retriever cache entries for ${inventory.savedPackages.length} package(s) referenced by the deleted user were not removed and must be cleaned up manually.`,
		)
	}

	result.deletedCommunityAssets = await deleteR2Objects({
		blobs: input.env.COMMUNITY_ASSETS,
		keys: uniqueStrings([
			...inventory.communityListings.flatMap((listing) => [
				buildCommunityIconR2Key({
					listingId: listing.id,
					commit: listing.pinnedCommit,
				}),
				buildCommunityIconR2Key({
					listingId: listing.id,
					commit: listing.iconCommit,
				}),
			]),
			inventory.avatarR2Key,
		]),
		label: 'Community asset',
		warnings,
	})
	result.deletedEmailBlobs = await deleteR2Objects({
		blobs: input.env.EMAIL_BLOBS,
		keys: inventory.emailBlobKeys,
		label: 'Email blob',
		warnings,
	})

	const d1Cleanup = await deleteUserScopedRows({
		env: input.env,
		mcpUserId: input.mcpUserId,
		dbUserId: input.dbUserId,
		warnings,
	})
	result.deletedRowCounts = d1Cleanup.deletedRowCounts
	result.updatedRowCounts = d1Cleanup.updatedRowCounts

	const helpers = input.env.OAUTH_PROVIDER
	if (helpers) {
		try {
			result.revokedOAuthGrants = await revokeAllOAuthGrants({
				helpers,
				userId: input.mcpUserId,
				warnings,
			})
		} catch (error) {
			const message = getErrorMessage(error)
			warnings.push(`OAuth grant revocation failed unexpectedly: ${message}`)
		}
	} else {
		warnings.push(
			'OAuth provider binding was unavailable; OAuth grants were not revoked.',
		)
	}

	const deletedUserRows = await deleteUserRow({
		env: input.env,
		dbUserId: input.dbUserId,
		warnings,
	})
	result.deletedRowCounts.users = deletedUserRows

	return result
}
