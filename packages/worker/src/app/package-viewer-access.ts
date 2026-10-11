import { type McpUserContext } from '@kody-internal/shared/chat.ts'
import {
	canSeeResource,
	computeEffectivePermissions,
	packageResource,
} from '#worker/authorization/authorize.ts'
import { loadOrgBindingForOrg } from '#worker/orgs/repo.ts'
import { deriveRequestContext } from '#worker/request-context/request-context.ts'

/**
 * Whether a signed-in person may open the owner view of a saved package on
 * `/@owner/<kody-id>`. Same rule as the org Repositories list: the person
 * belongs to (or holds a grant in) the org that owns the package, and
 * `canSeeResource` allows it there. The signup org owner sees every package
 * it owns; team org members see what their role, teams, and grants give them.
 */
export async function viewerCanSeeSavedPackage(input: {
	env: Env
	viewer: Pick<McpUserContext, 'userId' | 'username'> | null
	ownerId: string
	packageId: string
}): Promise<boolean> {
	if (!input.viewer) return false
	const binding = await loadOrgBindingForOrg(
		input.env.APP_DB,
		input.viewer.userId,
		input.ownerId,
	)
	if (!binding) return false
	const access = await computeEffectivePermissions({
		env: input.env,
		request: deriveRequestContext({
			user: input.viewer,
			source: { kind: 'session' },
			orgBinding: binding,
		}),
	})
	return canSeeResource(
		access,
		packageResource({ id: input.packageId, userId: input.ownerId }),
	)
}
