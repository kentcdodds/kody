/**
 * Durable storage id naming and ownership, kept free of Durable Object imports
 * so authorization checks can use them from any layer.
 */

const savedPackageIdUuidPattern =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Durable storage id of a saved package's own bucket. Reached via
 * `packageStorage()` from every package surface (invocations, jobs,
 * and package apps). Saved-package runtimes do not bind ambient `storage` to
 * this bucket; bundler provenance grants access through `packageStorage()`.
 */
export function buildPackageStorageId(packageId: string) {
	return `package:${encodeURIComponent(packageId)}`
}

/**
 * Whether one durable storage id belongs to a saved package: its raw id, its
 * deterministic bucket, its app facet buckets (`{packageId}:…`), and its
 * package job buckets (`job:package-job:{packageId}:…`).
 *
 * Prefix matching is UUID-gated on purpose. `package_save` accepts arbitrary
 * non-empty package ids, so a raw `{packageId}:` prefix could otherwise claim
 * reserved storage namespaces (`job:`, `exec:`, …) or carry LIKE metacharacters
 * (`%`, `_`) when this feeds inventory queries. A UUID cannot contain `:` or
 * those metacharacters and cannot equal the reserved namespace literals, which
 * makes `{uuid}:…` and `job:package-job:{uuid}:…` unambiguous.
 */
export function isPackageOwnedStorageId(input: {
	packageId: string
	storageId: string
}) {
	const packageId = input.packageId.trim()
	const storageId = input.storageId.trim()
	if (!packageId || !storageId) return false
	if (storageId === packageId) return true
	if (storageId === buildPackageStorageId(packageId)) return true
	if (!savedPackageIdUuidPattern.test(packageId)) return false
	return (
		storageId.startsWith(`${packageId}:`) ||
		storageId.startsWith(`job:package-job:${packageId}:`)
	)
}
