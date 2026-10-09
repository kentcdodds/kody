import { type McpUserContext } from '@kody-internal/shared/chat.ts'
import {
	personalOrgId,
	type OwnerId,
	type PersonId,
} from '@kody-internal/shared/owner-person-ids.ts'
import { type RequestContext } from '@kody-internal/shared/request-context.ts'
import { getMcpUserPackageScope } from './user-scope.ts'

/**
 * The acting-user / owning-org pair for a package operation.
 *
 * `ownerUserId` (an `OwnerId`) is the only id that may be used for
 * storage: `saved_packages.user_id`, `entity_sources.user_id`, Vectorize
 * metadata, repo-session RPC ownership, entitlements, and community listing
 * ownership. `actorUserId` (a `PersonId`) is the signed-in caller and is used
 * for audit and attribution only.
 */
export type PackageOwnerContext = {
	ownerUserId: OwnerId
	ownerScope: string
	ownerEmail: string
	actorUserId: PersonId
}

/**
 * Resolve the package owner for a capability call: the org the request is
 * bound to. Members author an org's packages through a connection bound to
 * that org; there is no per-call scope override.
 */
export async function resolvePackageOwnerContext(
	env: Pick<Env, 'APP_DB'>,
	input: { user: McpUserContext; request: RequestContext },
): Promise<PackageOwnerContext> {
	const { user, request } = input
	const isPersonalOrg = request.org.id === personalOrgId(user.userId)
	// A personal org's package scope follows the username, which can change
	// after signup (old names keep resolving through `username_redirects`).
	const ownerScope = isPersonalOrg
		? await getMcpUserPackageScope(env.APP_DB, user)
		: request.org.slug
	if (!ownerScope) {
		throw new Error(
			`Org ${request.org.id} has no slug, so it has no package scope.`,
		)
	}
	return {
		ownerUserId: request.org.id,
		ownerScope,
		ownerEmail: user.email,
		actorUserId: user.userId,
	}
}
