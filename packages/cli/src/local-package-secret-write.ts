/**
 * Local execute must not hop package-scoped secret mutations to CapabilityProxy.
 * Origin would otherwise often answer `insufficient_scope` for `secret:write` /
 * `secret:create` because the local bridge does not attach package secret
 * authority — a misleading hint to remint scopes.
 *
 * Keep this fail-closed: do not invent a local write path that trusts a
 * client-supplied package id as proof of a hosted package run.
 */

export const localPackageScopedSecretWriteUnavailableMessage =
	'Package-scoped secret writes are not available in local execution: the local CapabilityProxy bridge does not attach package secret authority (a client-supplied package id is not trusted). Run this via hosted package execute, or set the secret with the account UI (/connect/secret-set) or Open API secretSet with a user scope / outside local execute.'

const packageSecretMutations = new Set([
	'secretSet',
	'secretSetMany',
	'secretDelete',
])

function firstArgRecord(
	args: ReadonlyArray<unknown>,
): Record<string, unknown> | null {
	const first = args[0]
	if (first == null || typeof first !== 'object' || Array.isArray(first)) {
		return null
	}
	return first as Record<string, unknown>
}

function isPackageScope(value: unknown): boolean {
	return typeof value === 'string' && value.trim() === 'package'
}

/**
 * @returns Error message when this CapabilityProxy call is a package-scoped
 * secret mutation; otherwise null.
 */
export function localPackageScopedSecretWriteBlockReason(
	path: ReadonlyArray<string>,
	args: ReadonlyArray<unknown>,
): string | null {
	if (path.length !== 2 || path[0] !== 'kody') return null
	const name = path[1]
	if (typeof name !== 'string' || !packageSecretMutations.has(name)) return null

	const record = firstArgRecord(args)
	if (!record) return null

	if (name === 'secretSetMany') {
		const secrets = record.secrets
		if (!Array.isArray(secrets)) return null
		const touchesPackage = secrets.some((entry) => {
			if (entry == null || typeof entry !== 'object' || Array.isArray(entry)) {
				return false
			}
			return isPackageScope((entry as { scope?: unknown }).scope)
		})
		return touchesPackage
			? localPackageScopedSecretWriteUnavailableMessage
			: null
	}

	return isPackageScope(record.scope)
		? localPackageScopedSecretWriteUnavailableMessage
		: null
}

export function assertLocalPackageScopedSecretWriteAllowed(
	path: ReadonlyArray<string>,
	args: ReadonlyArray<unknown>,
): void {
	const reason = localPackageScopedSecretWriteBlockReason(path, args)
	if (reason) throw new Error(reason)
}
