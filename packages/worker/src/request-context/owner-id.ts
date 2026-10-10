/**
 * Storage and usage billing key for a caller.
 *
 * Org-owned rows, Durable Object names, secret AAD, Vectorize metadata, and
 * usage rollups use this id. It is `request.org.id` when the request has an
 * org, and the acting person otherwise (legacy wire callers without
 * `request`). Personal orgs reuse the person id, so those callers keep the
 * same key. Do not add another resolver: background identity still goes
 * through `resolveBackgroundMcpUser`.
 */
export function ownerIdFromCaller(caller: {
	request?: { org: { id: string } } | null
	user?: { userId: string } | null
}): string {
	return caller.request?.org.id ?? caller.user?.userId ?? ''
}
