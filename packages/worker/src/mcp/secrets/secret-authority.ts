import { AsyncLocalStorage } from 'node:async_hooks'
import { type StorageContext } from '#mcp/storage.ts'

/**
 * Host-validated stamp identity for secret reads/mounts. Sandbox fetch
 * wrappers copy this from the runtime ALS; capability proxies send the same
 * id as {@link secretAuthorityArgName}. The host only honors a requested id
 * that is in the run's provenance grant set (same collector as
 * `packageStorage()`).
 */
export const secretAuthorityHeaderName = 'x-kody-secret-authority'

/**
 * Hidden capability-arg field. Sandbox `kody.*` proxies attach the current
 * stamp id; `createToolDispatchers` peels it before zod parse so it never
 * becomes an author-facing schema field.
 */
export const secretAuthorityArgName = '__kodySecretAuthorityPackageId'

export const runtimeStorageSymbol = Symbol.for('kody.runtimeStorage')

type SecretAuthorityScope = {
	grantedPackageIds: ReadonlySet<string>
	currentPackageId: string | null
}

const secretAuthorityStorage = new AsyncLocalStorage<SecretAuthorityScope>()

export function runWithSecretAuthorityScope<T>(
	grantedPackageIds: ReadonlySet<string>,
	fn: () => T,
): T {
	return secretAuthorityStorage.run(
		{ grantedPackageIds, currentPackageId: null },
		fn,
	)
}

export function runWithCurrentSecretAuthority<T>(
	packageId: string | null,
	fn: () => T,
): T {
	const current = secretAuthorityStorage.getStore()
	if (!current) return fn()
	return secretAuthorityStorage.run(
		{ ...current, currentPackageId: packageId },
		fn,
	)
}

export function getSecretAuthorityScope() {
	return secretAuthorityStorage.getStore() ?? null
}

/**
 * Pick the package id that may use a secret for this call.
 *
 * A requested (stamp / header / capability) id wins only when it is in the
 * host grant set. Forged or unrelated ids fall back to the run. When the
 * host has not installed a grant set (unit tests, MCP outside a bundled
 * run), a requested id is accepted so callers can pass authority
 * explicitly.
 */
export function resolveSecretAuthorityPackageId(input: {
	requestedPackageId?: string | null
	grantedPackageIds?: ReadonlySet<string> | null
	runPackageId?: string | null
}): string | null {
	const requested = input.requestedPackageId?.trim() || null
	const run = input.runPackageId?.trim() || null
	if (requested) {
		if (!input.grantedPackageIds || input.grantedPackageIds.has(requested)) {
			return requested
		}
	}
	return run
}

type LooseStorageContext = {
	sessionId?: string | null
	appId?: string | null
	packageId?: string | null
	storageId?: string | null
}

export function storageContextWithSecretAuthority(
	storageContext: LooseStorageContext | null | undefined,
	authorityPackageId: string | null,
): StorageContext {
	return {
		sessionId: storageContext?.sessionId ?? null,
		appId: storageContext?.appId ?? null,
		packageId: authorityPackageId ?? storageContext?.packageId ?? null,
		storageId: storageContext?.storageId ?? null,
	}
}

export function resolveCallerSecretAuthority(input: {
	storageContext?: LooseStorageContext | null
	authorityPackageId?: string | null
}): {
	authorityPackageId: string | null
	storageContext: StorageContext
} {
	const scope = getSecretAuthorityScope()
	const authorityPackageId = resolveSecretAuthorityPackageId({
		requestedPackageId: input.authorityPackageId ?? scope?.currentPackageId,
		grantedPackageIds: scope?.grantedPackageIds,
		runPackageId: input.storageContext?.packageId,
	})
	return {
		authorityPackageId,
		storageContext: storageContextWithSecretAuthority(
			input.storageContext,
			authorityPackageId,
		),
	}
}

export function takeSecretAuthorityFromCapabilityArgs(args: Array<unknown>): {
	args: Array<unknown>
	requestedPackageId: string | null
} {
	const first = args[0]
	if (first == null || typeof first !== 'object' || Array.isArray(first)) {
		return { args, requestedPackageId: null }
	}
	const record = first as Record<string, unknown>
	if (!(secretAuthorityArgName in record)) {
		return { args, requestedPackageId: null }
	}
	const raw = record[secretAuthorityArgName]
	const requestedPackageId = typeof raw === 'string' ? raw.trim() || null : null
	const rest = { ...record }
	delete rest[secretAuthorityArgName]
	return { args: [rest, ...args.slice(1)], requestedPackageId }
}

export function readSecretAuthorityHeader(
	headers: Headers,
	grantedPackageIds?: ReadonlySet<string> | null,
): string | null {
	const requested = headers.get(secretAuthorityHeaderName)?.trim() || null
	if (!requested) return null
	if (grantedPackageIds && !grantedPackageIds.has(requested)) return null
	return requested
}

export function grantedSecretAuthorityPackageIdSet(
	ids: ReadonlyArray<string> | ReadonlySet<string> | null | undefined,
): ReadonlySet<string> | null {
	if (!ids) return null
	return ids instanceof Set ? ids : new Set(ids)
}
