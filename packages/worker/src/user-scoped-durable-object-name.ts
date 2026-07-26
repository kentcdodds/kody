/**
 * Frozen Durable Object `idFromName` builders for user-owned (and documented
 * exception) objects. Changing any of these strings or tuple layouts creates
 * new objects and strands existing object storage. See
 * `docs/contributing/architecture/data-storage.md` (§ Durable Object id
 * contracts).
 *
 * JSON-tuple names use {@link durableObjectNameFromParts} so components that
 * may contain `/` or `:` round-trip unambiguously.
 */

/**
 * Encode Durable Object name parts as a JSON tuple. Prefer the typed helpers
 * below at call sites; use this only when building a new user-scoped DO name
 * that is not yet covered by a dedicated helper.
 */
export function durableObjectNameFromParts(
	parts: ReadonlyArray<string>,
): string {
	return JSON.stringify(parts)
}

/** JobManager — one scheduler DO per user. */
export function jobManagerDurableObjectName(userId: string) {
	return userId
}

/** RunLog — one execution-history DO per user. */
export function runLogDurableObjectName(userId: string) {
	return userId
}

/** McpClientHub — one client-hub DO per user (trimmed). */
export function mcpClientHubDurableObjectName(userId: string) {
	return userId.trim()
}

/** StorageRunner — isolated SQLite DO per (userId, storageId). */
export function storageRunnerDurableObjectName(
	userId: string,
	storageId: string,
) {
	return durableObjectNameFromParts([userId, storageId])
}

/** PackageRealtimeSession — live app session DO per (userId, packageId). */
export function packageRealtimeSessionDurableObjectName(input: {
	userId: string
	packageId: string
}) {
	return durableObjectNameFromParts([input.userId, input.packageId])
}

/**
 * PackageServiceInstance — long-lived service DO per
 * (userId, packageId, serviceName).
 */
export function packageServiceInstanceDurableObjectName(input: {
	userId: string
	packageId: string
	serviceName: string
}) {
	return durableObjectNameFromParts([
		input.userId,
		input.packageId,
		input.serviceName,
	])
}

/**
 * RepoSession is keyed by `repo_sessions.id` only (not user-prefixed). Every
 * RPC must validate the D1 session row's `user_id` before touching the
 * workspace. Account deletion enumerates the user's session ids before
 * deleting D1 rows and purges each DO. Documented exception to user-scoped
 * naming — do not "fix" this by prefixing userId without a storage
 * migration plan.
 */
export function repoSessionDurableObjectName(sessionId: string) {
	return sessionId
}
