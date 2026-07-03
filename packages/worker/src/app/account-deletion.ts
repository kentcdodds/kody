import { storageRunnerRpc } from '#worker/storage-runner.ts'
import { jobVectorId } from '#mcp/jobs-vectorize.ts'
import { memoryVectorId } from '#mcp/memory/memory-vectorize.ts'
import { savedPackageVectorId } from '#worker/package-registry/repo.ts'
import { getCapabilityVectorIndex } from '#mcp/capabilities/capability-search.ts'
import { cleanupAllUserArtifactRepos } from '#worker/repo/artifact-repo-cleanup.ts'

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
	deletedKvKeys: number
	deletedArtifactRepos: number
	revokedOAuthGrants: number
	clearedDurableObjects: Record<string, number>
	deletedVectors: number
	warnings: Array<string>
}

type UserScopedDeleteTarget =
	| { kind: 'user_id'; table: string }
	| { kind: 'db_user_id'; table: string }
	| { kind: 'bucket_parent'; table: string; parentTable: string }
	| { kind: 'attachment_parent'; table: string }
	| { kind: 'mcp_memory_suppression' }

/**
 * Tables that are scoped by `user_id` (directly or transitively) and should
 * be cascade-deleted when a user removes their account. The list is
 * intentionally explicit so adding a new user-scoped table requires a
 * deliberate update here (and a corresponding test).
 *
 * Order matters: child tables come before parent tables so the cascade is
 * self-contained even on engines / configs where foreign-key cascades are
 * disabled. Tables with no `user_id` column (e.g. global mock tables) are
 * not represented.
 */
const userScopedTables: ReadonlyArray<UserScopedDeleteTarget> = [
	{ kind: 'user_id', table: 'package_invocations' },
	{ kind: 'user_id', table: 'package_invocation_tokens' },
	{ kind: 'user_id', table: 'workflow_runs' },
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
	{ kind: 'user_id', table: 'chat_threads' },
	// password_resets.user_id is an INTEGER FK to users.id (predates the
	// stable mcp string user id), so it must be cleared with the database
	// integer id rather than the mcp user id.
	{ kind: 'db_user_id', table: 'password_resets' },
	{ kind: 'db_user_id', table: 'user_roles' },
]

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
	const jobRows = await env.APP_DB.prepare(
		`SELECT storage_id FROM jobs WHERE user_id = ? AND storage_id IS NOT NULL`,
	)
		.bind(userId)
		.all<{ storage_id: string }>()
	return Array.from(
		new Set(
			(jobRows.results ?? [])
				.map((row) => row.storage_id)
				.filter((id): id is string => Boolean(id)),
		),
	)
}

async function listUserBundleKvKeys(env: Env, userId: string) {
	const published = await env.APP_DB.prepare(
		`SELECT kv_key FROM published_bundle_artifacts WHERE user_id = ?`,
	)
		.bind(userId)
		.all<{ kv_key: string }>()
	const archived = await env.APP_DB.prepare(
		`SELECT kv_key FROM archived_job_artifacts WHERE user_id = ?`,
	)
		.bind(userId)
		.all<{ kv_key: string }>()
	const keys = new Set<string>()
	for (const row of published.results ?? []) {
		if (row.kv_key) keys.add(row.kv_key)
	}
	for (const row of archived.results ?? []) {
		if (row.kv_key) keys.add(row.kv_key)
	}
	return Array.from(keys)
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
			const message = error instanceof Error ? error.message : String(error)
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
				const message = error instanceof Error ? error.message : String(error)
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
			const message = error instanceof Error ? error.message : String(error)
			input.warnings.push(
				`Storage runner clear failed for ${storageId}: ${message}`,
			)
		}
	}
	return cleared
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
			const message = error instanceof Error ? error.message : String(error)
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
			const message = error instanceof Error ? error.message : String(error)
			input.warnings.push(`KV delete failed for ${key}: ${message}`)
		}
	}
	return deleted
}

async function deleteUserScopedRows(input: {
	env: Env
	mcpUserId: string
	dbUserId: number
	warnings: Array<string>
}): Promise<Record<string, number>> {
	const counts: Record<string, number> = {}
	for (const target of userScopedTables) {
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
			counts[tableName] = result.meta.changes ?? 0
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error)
			const targetLabel =
				target.kind === 'mcp_memory_suppression'
					? 'mcp_memory_conversation_suppressions'
					: target.table
			input.warnings.push(`Failed to delete from ${targetLabel}: ${message}`)
			counts[targetLabel] = 0
		}
	}
	return counts
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
		const message = error instanceof Error ? error.message : String(error)
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
 *   1. Pre-collect identifiers we need (vector ids, storage ids, KV keys)
 *      while their owning rows still exist.
 *   2. Best-effort destructive cleanup of out-of-band stores (Vectorize,
 *      KV, durable storage) - each batch records a warning on failure but
 *      does not abort the cascade.
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
		deletedKvKeys: 0,
		deletedArtifactRepos: 0,
		revokedOAuthGrants: 0,
		clearedDurableObjects: {},
		deletedVectors: 0,
		warnings,
	}

	const [vectorIds, storageIds, bundleKvKeys] = await Promise.all([
		listUserVectorIds(input.env, input.mcpUserId).catch((error) => {
			const message = error instanceof Error ? error.message : String(error)
			warnings.push(`Failed to enumerate vector ids: ${message}`)
			return [] as Array<string>
		}),
		listUserStorageIds(input.env, input.mcpUserId).catch((error) => {
			const message = error instanceof Error ? error.message : String(error)
			warnings.push(`Failed to enumerate storage ids: ${message}`)
			return [] as Array<string>
		}),
		listUserBundleKvKeys(input.env, input.mcpUserId).catch((error) => {
			const message = error instanceof Error ? error.message : String(error)
			warnings.push(`Failed to enumerate bundle KV keys: ${message}`)
			return [] as Array<string>
		}),
	])

	result.deletedVectors = await deleteVectorsByIds({
		env: input.env,
		ids: vectorIds,
		warnings,
	})

	result.deletedArtifactRepos = await cleanupAllUserArtifactRepos({
		env: input.env,
		userId: input.mcpUserId,
		warnings,
	}).catch((error) => {
		const message = error instanceof Error ? error.message : String(error)
		warnings.push(`Artifact repo cleanup failed unexpectedly: ${message}`)
		return 0
	})

	result.clearedDurableObjects.storageRunners = await clearStorageRunners({
		env: input.env,
		userId: input.mcpUserId,
		storageIds,
		warnings,
	})

	if (input.env.BUNDLE_ARTIFACTS_KV) {
		result.deletedKvKeys = await deleteKvKeys({
			kv: input.env.BUNDLE_ARTIFACTS_KV,
			keys: bundleKvKeys,
			warnings,
		})
	} else if (bundleKvKeys.length > 0) {
		// We collected keys from D1 (published_bundle_artifacts /
		// archived_job_artifacts) but the KV binding is missing, so
		// deleteUserScopedRows below would drop the D1 rows without
		// reaping the underlying KV entries. Surface that as a warning
		// so the operator knows the KV namespace needs a manual sweep.
		warnings.push(
			`BUNDLE_ARTIFACTS_KV binding was unavailable; ${bundleKvKeys.length} bundle artifact key(s) referenced by the deleted user were not removed and must be cleaned up manually.`,
		)
	}

	result.deletedRowCounts = await deleteUserScopedRows({
		env: input.env,
		mcpUserId: input.mcpUserId,
		dbUserId: input.dbUserId,
		warnings,
	})

	const helpers = input.env.OAUTH_PROVIDER
	if (helpers) {
		try {
			result.revokedOAuthGrants = await revokeAllOAuthGrants({
				helpers,
				userId: input.mcpUserId,
				warnings,
			})
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error)
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
