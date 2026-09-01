/**
 * Durable storage id naming and ownership, kept free of Durable Object imports
 * so authorization checks can use them from any layer.
 */

const savedPackageIdUuidPattern =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Durable storage id of a saved package's own bucket. Reached via
 * `packageStorage()` from every package surface (invocations, jobs,
 * and package apps). Bundler provenance grants access through
 * `packageStorage()`.
 */
export function buildPackageStorageId(packageId: string) {
	return `package:${encodeURIComponent(packageId)}`
}

/**
 * Whether one durable storage id belongs to a saved package: its raw id, its
 * deterministic bucket, its app facet buckets (`{packageId}:…`), and its
 * package job buckets (`job:package-job:{packageId}:…`).
 *
 * Prefix matching is UUID-gated on purpose. `packageSave` accepts arbitrary
 * non-empty package ids, so a raw `{packageId}:` prefix could otherwise claim
 * reserved storage namespaces (`job:`, `exec:`, …) or carry LIKE metacharacters
 * (`%`, `_`) when this feeds inventory queries. A UUID cannot contain `:` or
 * those metacharacters and cannot equal the reserved namespace literals, which
 * makes `{uuid}:…` and `job:package-job:{uuid}:…` unambiguous.
 *
 * Ids compare exactly: normalizing here would let a whitespace-padded package id
 * claim another package's buckets, and durable object names are derived from the
 * raw id anyway.
 */
export function isPackageOwnedStorageId(input: {
	packageId: string
	storageId: string
}) {
	const { packageId, storageId } = input
	if (!packageId.trim() || !storageId.trim()) return false
	if (storageId === packageId) return true
	if (storageId === buildPackageStorageId(packageId)) return true
	if (!savedPackageIdUuidPattern.test(packageId)) return false
	return (
		storageId.startsWith(`${packageId}:`) ||
		storageId.startsWith(`job:package-job:${packageId}:`)
	)
}
