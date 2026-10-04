import { AsyncLocalStorage } from 'node:async_hooks'
import { type ConnectionProfileGrant } from '#universal/connection-profiles/grants.ts'

/**
 * Request-scoped profile grant allowlist for package import resolution and
 * other deep call sites that do not carry `McpCallerContext`.
 *
 * - store missing → treat as unlimited (tests / paths outside a profile wrap)
 * - `null` → unlimited (explicit)
 * - array (including empty) → allowlist for a named profile
 */
const connectionProfileGrantsStorage =
	new AsyncLocalStorage<ReadonlyArray<ConnectionProfileGrant> | null>()

export function runWithConnectionProfileGrants<T>(
	grants: ReadonlyArray<ConnectionProfileGrant> | null,
	fn: () => T,
): T {
	return connectionProfileGrantsStorage.run(grants, fn)
}

export function getRequestConnectionProfileGrants():
	| ReadonlyArray<ConnectionProfileGrant>
	| null
	| undefined {
	return connectionProfileGrantsStorage.getStore()
}
