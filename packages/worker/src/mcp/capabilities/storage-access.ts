import { type McpCallerContext } from '@kody-internal/shared/chat.ts'
import { McpCallerError } from '#mcp/caller-error.ts'
import { isPackageOwnedStorageId } from '#worker/storage-ids.ts'

export function createStorageBucketAccessDeniedMessage(input: {
	capabilityName: string
	packageId: string
	storageId: string
}) {
	return (
		`${input.capabilityName} cannot use storage bucket "${input.storageId}" from package "${input.packageId}". ` +
		'Package runtimes reach only their own buckets by id: the package bucket, its app facet buckets, and its package job buckets. ' +
		"Another package's bucket is reachable only through packageStorage(), which is gated by bundler-recorded provenance grants."
	)
}

/**
 * Authorize a caller-supplied durable storage id for one capability call.
 *
 * StorageRunner buckets are keyed on (userId, storageId), so scoping by the
 * authenticated user alone lets a caller name every bucket in the account.
 * Package runtimes execute untrusted community code, so when the caller runs
 * as a package the requested bucket must belong to that package — the same
 * boundary `packageStorage()` and the package-app storage bridge enforce.
 * User-driven callers (chat, MCP clients, `execute` outside a package) keep
 * account-scoped access to their own buckets.
 *
 * A package caller may also name the bucket the host already bound for this run
 * (`storageContext.storageId`) even when that id is not package-shaped, so a job
 * a package created keeps reaching the bucket its own run writes.
 *
 * The id is returned verbatim: durable object names come from the raw string, so
 * normalizing here would silently retarget a bucket whose id carries whitespace.
 */
export function authorizeCapabilityStorageId(input: {
	callerContext: McpCallerContext
	capabilityName: string
	storageId: string
}) {
	const storageId = input.storageId
	if (!storageId.trim()) {
		throw new McpCallerError('storage id must be a non-empty string.')
	}
	const packageId = input.callerContext.storageContext?.packageId
	if (!packageId?.trim()) return storageId
	if (storageId === input.callerContext.storageContext?.storageId) {
		return storageId
	}
	if (isPackageOwnedStorageId({ packageId, storageId })) return storageId
	throw new McpCallerError(
		createStorageBucketAccessDeniedMessage({
			capabilityName: input.capabilityName,
			packageId,
			storageId,
		}),
	)
}
