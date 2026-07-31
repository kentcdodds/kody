import { getErrorMessage } from '@kody-internal/shared/error-message.ts'
import { storageRunnerRpc } from '#worker/storage-runner.ts'
import { purgeJobManagerForUser } from '#worker/jobs/manager-client.ts'
import { jobVectorId } from '#mcp/jobs-vectorize.ts'
import { memoryVectorId } from '#mcp/memory/memory-vectorize.ts'
import { savedPackageVectorId } from '#worker/package-registry/repo.ts'
import { getCapabilityVectorIndex } from '#worker/vectorize/embedding.ts'
import { cleanupAllUserArtifactRepos } from '#worker/repo/artifact-repo-cleanup.ts'
import { repoSessionRpc } from '#worker/repo/repo-session-rpc.ts'
import { userScopedConnectorSessionKey } from '#worker/remote-connector/connector-session-key.ts'
import { mcpClientHubDurableObjectName } from '#worker/user-scoped-durable-object-name.ts'
import { packageServiceRpc } from '#worker/package-runtime/package-service.ts'
import { packageRealtimeSessionRpc } from '#worker/package-runtime/realtime-session.ts'
import { clearRunRecords } from '#worker/run-records/service.ts'
import {
	listAccountUserPackageServices,
	listAccountUserStorageIds,
} from '#worker/account/user-inventory.ts'
import {
	accountUserDataTargets,
	buildUserScopedDeleteOrUpdateSql,
	buildUserScopedTargetMatch,
	getAccountD1UserColumnCoverage,
} from '#worker/account/data-targets.ts'
import {
	accountUserOwnedVectorizeSurfaces,
	getAccountDeletionDurableObjectResultKeys,
} from '#worker/account/user-owned-surfaces.ts'
import {
	collectAccountR2Inventory,
	type AccountCommunityListingSnapshot,
	type AccountR2ObjectRef,
} from '#worker/account/r2-inventory.ts'
import {
	deleteAccountCommunityAssetPrefixes,
	deleteAccountEmailBlobPrefixes,
} from '#app/account-r2-prefix-cleanup.ts'
import {
	listMcpAgentSessionsForUser,
	type McpAgentSession,
} from '#mcp/session-registry.ts'
import {
	AccountDeletionWritersActiveError,
	markAccountDeleting,
} from '#worker/account/deletion-state.ts'
import {
	buildPublishedSourceManifestSnapshotKvKey,
	buildPublishedSourceSnapshotKvKey,
} from '#worker/package-runtime/published-runtime-artifacts.ts'
import { deleteAllPackageRetrieverCacheEntriesForUser } from '#worker/package-retrievers/manifest-cache.ts'
import { buildCommunitySnapshotKvKey } from '#worker/community/snapshot.ts'
import { buildCommunityIconCacheKey } from '#worker/community/community-icon.ts'
import { derivedCacheKeyPrefix } from '#worker/kv-cachified.ts'

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

type UserDeletionInventory = {
	vectorIds: Array<string>
	storageIds: Array<string>
	bundleKvKeys: Array<string>
	r2Objects: Array<AccountR2ObjectRef>
	sourceSnapshots: Array<UserSourceSnapshot>
	savedPackages: Array<UserSavedPackageSnapshot>
	repoSessions: Array<UserRepoSessionSnapshot>
	remoteConnectors: Array<UserRemoteConnectorSnapshot>
	mcpServers: Array<UserMcpServerSnapshot>
	mcpAgentSessions: Array<McpAgentSession>
	packageServices: Array<UserPackageServiceSnapshot>
	communityListings: Array<AccountCommunityListingSnapshot>
}

export class AccountDeletionInventoryError extends Error {
	readonly inventoryErrors: ReadonlyArray<string>

	constructor(inventoryErrors: ReadonlyArray<string>) {
		super('Account deletion inventory could not be collected safely.')
		this.name = 'AccountDeletionInventoryError'
		this.inventoryErrors = [...inventoryErrors]
	}
}

export class AccountDeletionCleanupError extends Error {
	readonly cleanupErrors: ReadonlyArray<string>
	readonly partialResult: AccountDeletionResult

	constructor(
		cleanupErrors: ReadonlyArray<string>,
		partialResult: AccountDeletionResult,
	) {
		super('Account deletion cleanup could not complete safely.')
		this.name = 'AccountDeletionCleanupError'
		this.cleanupErrors = [...cleanupErrors]
		this.partialResult = partialResult
	}
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

const vectorIdBuildersBySurfaceId = {
	memory: memoryVectorId,
	job: jobVectorId,
	saved_package: savedPackageVectorId,
} as const

async function listUserVectorIds(env: Env, userId: string) {
	const ids: Array<string> = []
	for (const surface of accountUserOwnedVectorizeSurfaces) {
		const rows = await env.APP_DB.prepare(
			`SELECT id FROM ${surface.sourceTable} WHERE user_id = ?`,
		)
			.bind(userId)
			.all<{ id: string }>()
		const buildId = vectorIdBuildersBySurfaceId[surface.id]
		for (const row of rows.results ?? []) {
			ids.push(buildId(row.id))
		}
	}
	return ids
}

async function listUserStorageIds(
	env: Env,
	userId: string,
	warnings?: Array<string>,
	packageServices?: ReadonlyArray<UserPackageServiceSnapshot>,
) {
	return await listAccountUserStorageIds({
		env,
		userId,
		baseUrl: 'https://account-deletion.invalid',
		warnings,
		packageServices,
	})
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

async function listUserPackageServices(
	env: Env,
	userId: string,
	warnings?: Array<string>,
) {
	return await listAccountUserPackageServices({
		env,
		userId,
		baseUrl: 'https://account-deletion.invalid',
		warnings,
	})
}

async function listUserBundleKvKeys(input: {
	env: Env
	userId: string
	sourceSnapshots: ReadonlyArray<UserSourceSnapshot>
	communityListings: ReadonlyArray<AccountCommunityListingSnapshot>
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

async function collectUserDeletionInventory(input: {
	env: Env
	userId: string
	dbUserId: number
	warnings: Array<string>
}): Promise<UserDeletionInventory> {
	const inventoryErrors: Array<string> = []
	const recordInventoryError = (label: string, error: unknown) => {
		const warning = `Failed to enumerate ${label}: ${getErrorMessage(error)}`
		input.warnings.push(warning)
		inventoryErrors.push(warning)
	}
	// Enumerate services first so storage-id listing can reuse the result and
	// avoid a second package-manifest pass in the same request.
	const packageServices = await listUserPackageServices(
		input.env,
		input.userId,
		input.warnings,
	).catch((error) => {
		recordInventoryError('package services', error)
		return [] as Array<UserPackageServiceSnapshot>
	})
	const [
		vectorIds,
		storageIds,
		r2Inventory,
		sourceSnapshots,
		savedPackages,
		repoSessions,
		remoteConnectors,
		mcpServers,
		mcpAgentSessions,
	] = await Promise.all([
		listUserVectorIds(input.env, input.userId).catch((error) => {
			recordInventoryError('vector ids', error)
			return [] as Array<string>
		}),
		listUserStorageIds(
			input.env,
			input.userId,
			input.warnings,
			packageServices,
		).catch((error) => {
			recordInventoryError('storage ids', error)
			return [] as Array<string>
		}),
		collectAccountR2Inventory({
			env: input.env,
			userId: input.userId,
			dbUserId: input.dbUserId,
		}).catch((error) => {
			recordInventoryError('R2 objects', error)
			return {
				objects: [] as Array<AccountR2ObjectRef>,
				communityListings: [] as Array<AccountCommunityListingSnapshot>,
			}
		}),
		listUserSourceSnapshots(input.env, input.userId).catch((error) => {
			recordInventoryError('source snapshots', error)
			return [] as Array<UserSourceSnapshot>
		}),
		listUserSavedPackages(input.env, input.userId).catch((error) => {
			recordInventoryError('saved packages', error)
			return [] as Array<UserSavedPackageSnapshot>
		}),
		listUserRepoSessions(input.env, input.userId).catch((error) => {
			recordInventoryError('repo sessions', error)
			return [] as Array<UserRepoSessionSnapshot>
		}),
		listUserRemoteConnectors(input.env, input.userId).catch((error) => {
			recordInventoryError('remote connectors', error)
			return [] as Array<UserRemoteConnectorSnapshot>
		}),
		listUserMcpServers(input.env, input.userId).catch((error) => {
			recordInventoryError('MCP servers', error)
			return [] as Array<UserMcpServerSnapshot>
		}),
		listMcpAgentSessionsForUser(input.env.APP_DB, input.userId).catch(
			(error) => {
				recordInventoryError('MCP agent sessions', error)
				return [] as Array<McpAgentSession>
			},
		),
	])
	const bundleKvKeys = await listUserBundleKvKeys({
		env: input.env,
		userId: input.userId,
		sourceSnapshots,
		communityListings: r2Inventory.communityListings,
	}).catch((error) => {
		recordInventoryError('bundle KV keys', error)
		return [] as Array<string>
	})
	if (inventoryErrors.length > 0) {
		throw new AccountDeletionInventoryError(inventoryErrors)
	}
	return {
		vectorIds,
		storageIds,
		bundleKvKeys,
		r2Objects: r2Inventory.objects,
		sourceSnapshots,
		savedPackages,
		repoSessions,
		remoteConnectors,
		mcpServers,
		mcpAgentSessions,
		packageServices,
		communityListings: r2Inventory.communityListings,
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

async function clearRunLog(input: {
	env: Env
	userId: string
	warnings: Array<string>
}): Promise<number> {
	try {
		if (!(input.env as Partial<Env>).RUN_LOG) {
			input.warnings.push(
				'RUN_LOG binding was unavailable; the user run log Durable Object was not purged.',
			)
			return 0
		}
		await clearRunRecords({ env: input.env, userId: input.userId })
		return 1
	} catch (error) {
		const message = getErrorMessage(error)
		input.warnings.push(`Run log clear failed: ${message}`)
		return 0
	}
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

async function purgeMcpAgentSessions(input: {
	env: Env
	userId: string
	sessions: ReadonlyArray<McpAgentSession>
	warnings: Array<string>
}) {
	const namespace = input.env.MCP_OBJECT
	if (!namespace) {
		if (input.sessions.length > 0) {
			input.warnings.push(
				`MCP_OBJECT binding was unavailable; ${input.sessions.length} MCP agent session(s) were not purged.`,
			)
		}
		return 0
	}
	let purged = 0
	for (const session of input.sessions) {
		try {
			const stub = namespace.get(
				namespace.idFromString(session.doId),
			) as unknown as {
				purgeForAccountDeletion: (payload: { userId: string }) => Promise<void>
			}
			await stub.purgeForAccountDeletion({ userId: input.userId })
			purged += 1
		} catch (error) {
			input.warnings.push(
				`MCP agent session purge failed for ${session.doId}: ${getErrorMessage(error)}`,
			)
		}
	}
	return purged
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
	if (!index) {
		input.warnings.push(
			`CAPABILITY_VECTOR_INDEX binding was unavailable; ${input.ids.length} user vector(s) were not removed.`,
		)
		return 0
	}
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
	warnings: Array<string>
}) {
	try {
		return await deleteAllPackageRetrieverCacheEntriesForUser({
			env: input.env,
			userId: input.userId,
		})
	} catch (error) {
		const message = getErrorMessage(error)
		input.warnings.push(`Package retriever KV cleanup failed: ${message}`)
		return 0
	}
}

async function deleteUserScopedRowsAndUser(input: {
	env: Env
	mcpUserId: string
	dbUserId: number
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
	const operations = accountUserDataTargets.map((target) => {
		const match = buildUserScopedTargetMatch({
			target,
			mcpUserId: input.mcpUserId,
			dbUserId: input.dbUserId,
		})
		const { sql, params } = buildUserScopedDeleteOrUpdateSql(match)
		return {
			match,
			statement: input.env.APP_DB.prepare(sql).bind(...params),
		}
	})
	const userStatement = input.env.APP_DB.prepare(
		`DELETE FROM users WHERE id = ?`,
	).bind(input.dbUserId)
	const results = await input.env.APP_DB.batch([
		...operations.map((operation) => operation.statement),
		userStatement,
	])
	for (const [index, operation] of operations.entries()) {
		const changes = results[index]?.meta.changes
		if (operation.match.mutation.kind === 'delete') {
			recordDeleted(operation.match.table, changes)
		} else {
			recordUpdated(operation.match.table, changes)
		}
	}
	deletedRowCounts.users = results.at(-1)?.meta.changes ?? 0
	return { deletedRowCounts, updatedRowCounts }
}

/**
 * Orchestrate a full per-user data cleanup. The caller is responsible for
 * verifying the user's identity before invoking this; the orchestrator does
 * not re-authenticate.
 *
 * The cleanup ordering is:
 *   1. Pre-collect identifiers we need (vector ids, storage ids, KV keys,
 *      repo/session/package ids) while their owning rows still exist.
 *   2. Idempotent cleanup of out-of-band stores and OAuth grants.
 *   3. Abort while preserving D1 inventory and the user row if any critical
 *      cleanup failed. The five-minute usage-rollup derived cache is the sole
 *      TTL-owned omission and does not participate in this gate.
 *   4. Atomically delete user-scoped D1 rows and the user row in one batch.
 */
export async function deleteUserAccount(input: {
	env: AccountDeletionEnv
	dbUserId: number
	mcpUserId: string
}): Promise<AccountDeletionResult> {
	const activeWriteCount = await markAccountDeleting({
		db: input.env.APP_DB,
		dbUserId: input.dbUserId,
	})
	if (activeWriteCount > 0) {
		throw new AccountDeletionWritersActiveError(activeWriteCount)
	}
	const warnings: Array<string> = []
	const clearedDurableObjects: Record<string, number> = {}
	for (const key of getAccountDeletionDurableObjectResultKeys()) {
		clearedDurableObjects[key] = 0
	}
	const result: AccountDeletionResult = {
		deletedRowCounts: {},
		updatedRowCounts: {},
		deletedKvKeys: 0,
		deletedCommunityAssets: 0,
		deletedEmailBlobs: 0,
		deletedArtifactRepos: 0,
		revokedOAuthGrants: 0,
		clearedDurableObjects,
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
	result.clearedDurableObjects.mcpAgentSessions = await purgeMcpAgentSessions({
		env: input.env,
		userId: input.mcpUserId,
		sessions: inventory.mcpAgentSessions,
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
	result.clearedDurableObjects.runLogs = await clearRunLog({
		env: input.env,
		userId: input.mcpUserId,
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
				...inventory.communityListings.map(
					(listing) =>
						`${derivedCacheKeyPrefix}community-icon:v1:${listing.id}:`,
				),
				// Package-codemod apply snapshots are user-namespaced in KV
				// (`package-codemod-revert:{userId}:{itemId}`). D1 run items are
				// deleted separately; purge the orphaned revert trees here rather
				// than waiting on the 90-day TTL.
				`package-codemod-revert:${input.mcpUserId}:`,
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

	try {
		result.deletedCommunityAssets = await deleteAccountCommunityAssetPrefixes({
			bucket: input.env.COMMUNITY_ASSETS,
			stableUserId: input.mcpUserId,
			listingIds: inventory.communityListings.map((listing) => listing.id),
		})
	} catch (error) {
		warnings.push(getErrorMessage(error))
	}
	const emailBlobs = input.env.EMAIL_BLOBS
	if (!emailBlobs) {
		warnings.push(
			'EMAIL_BLOBS binding was unavailable; email objects were not removed.',
		)
	} else {
		try {
			result.deletedEmailBlobs = await deleteAccountEmailBlobPrefixes({
				bucket: emailBlobs,
				stableUserId: input.mcpUserId,
			})
		} catch (error) {
			warnings.push(getErrorMessage(error))
		}
		result.deletedEmailBlobs += await deleteR2Objects({
			blobs: emailBlobs,
			keys: inventory.r2Objects
				.filter((object) => object.binding === 'EMAIL_BLOBS')
				.filter(
					(object) =>
						!object.key.startsWith(`email-raw:v1:${input.mcpUserId}/`) &&
						!object.key.startsWith(`email-attachment:v1:${input.mcpUserId}/`),
				)
				.map((object) => object.key),
			label: 'Email blob',
			warnings,
		})
	}

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

	if (warnings.length > 0) {
		throw new AccountDeletionCleanupError(warnings, result)
	}

	try {
		const d1Cleanup = await deleteUserScopedRowsAndUser({
			env: input.env,
			mcpUserId: input.mcpUserId,
			dbUserId: input.dbUserId,
		})
		result.deletedRowCounts = d1Cleanup.deletedRowCounts
		result.updatedRowCounts = d1Cleanup.updatedRowCounts
	} catch (error) {
		const failure = `Atomic D1 account deletion failed: ${getErrorMessage(error)}`
		warnings.push(failure)
		throw new AccountDeletionCleanupError(warnings, result)
	}

	return result
}
