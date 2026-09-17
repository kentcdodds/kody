const uuidPattern =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * 1Password Connect item ids (not Service Account / UUID item ids).
 * @see https://developer.1password.com/docs/connect/
 */
const connectItemIdPattern = /^[a-z0-9]{26}$/

/**
 * Platform-canonical item ref: `i/<item-id>/<field>`.
 * Item id is a UUID or a 1Password Connect 26-char id.
 * Field is everything after the second slash so sectioned fields stay intact.
 */
const canonicalItemRefPattern = /^i\/([^/]+)\/(.+)$/

/**
 * Optional synonym helper for 1Password-shaped `op://…` input. Core does not
 * talk to a vault here: when the item segment is already a UUID or Connect
 * item id, this maps to the same grant/cache key as `i/<item-id>/<field>`.
 * Name-based `op://` refs still need the bound provider's sealed canonicalize
 * export.
 */
const opSecretReferencePattern = /^op:\/\/([^/]+)\/([^/]+)\/(.+)$/i

export type CanonicalItemRef = {
	itemId: string
	field: string
}

export function isUuid(value: string) {
	return uuidPattern.test(value.trim())
}

export function isConnectItemId(value: string) {
	return connectItemIdPattern.test(value.trim())
}

export function isCanonicalItemId(value: string) {
	const trimmed = value.trim()
	return isUuid(trimmed) || isConnectItemId(trimmed)
}

export function parseCanonicalItemRef(ref: string): CanonicalItemRef | null {
	const match = canonicalItemRefPattern.exec(ref.trim())
	if (!match) return null
	const itemId = match[1]?.trim() ?? ''
	const field = match[2]?.trim() ?? ''
	if (!isCanonicalItemId(itemId) || !field) return null
	return { itemId: itemId.toLowerCase(), field }
}

export function formatCanonicalItemRef(input: CanonicalItemRef) {
	return `i/${input.itemId.toLowerCase()}/${input.field}`
}

export function isCanonicalProviderRef(ref: string) {
	return parseCanonicalItemRef(ref) !== null
}

/**
 * Best-effort local canonicalize used before grants and cache lookups.
 * Returns the canonical `i/<item-id>/<field>` form, or null when the provider
 * must canonicalize (name-based `op://`, unknown synonym, or broken ref).
 */
export function tryCanonicalizeProviderRef(ref: string): string | null {
	const trimmed = ref.trim()
	if (!trimmed) return null
	const already = parseCanonicalItemRef(trimmed)
	if (already) return formatCanonicalItemRef(already)
	return canonicalizeOpSecretReference(trimmed)
}

/**
 * Maps `op://<vault>/<item-id>/<field>` to `i/<item-id>/<field>` when the
 * item segment is a UUID or Connect item id. Vault names and other item
 * segments are not interpreted.
 */
export function canonicalizeOpSecretReference(ref: string): string | null {
	const match = opSecretReferencePattern.exec(ref.trim())
	if (!match) return null
	const item = match[2]?.trim() ?? ''
	const field = match[3]?.trim() ?? ''
	if (!isCanonicalItemId(item) || !field) return null
	return formatCanonicalItemRef({ itemId: item, field })
}
