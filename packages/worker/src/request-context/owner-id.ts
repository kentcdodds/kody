import {
	type OwnerId,
	type PersonId,
	personalOrgId,
} from '@kody-internal/shared/owner-person-ids.ts'

/**
 * Storage and usage billing key for a caller.
 *
 * Org-owned rows, Durable Object names, secret AAD, Vectorize metadata, and
 * usage rollups use this id. It is `request.org.id` when the request has an
 * org, and the acting person's personal org otherwise (legacy wire callers
 * without `request`). Personal orgs reuse the person id, so those callers
 * keep the same key. Do not add another resolver: background identity still
 * goes through `resolveBackgroundMcpUser`. Does not trim: a missing caller
 * is still the empty string callers treat as absent.
 */
export function ownerIdFromCaller(caller: {
	request?: { org: { id: OwnerId } } | null
	user?: { userId: PersonId } | null
}): OwnerId {
	if (caller.request) return caller.request.org.id
	if (caller.user) return personalOrgId(caller.user.userId)
	return '' as OwnerId
}
