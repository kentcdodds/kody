import { type McpUserContext } from '@kody-internal/shared/chat.ts'
import {
	checkPermission,
	computeEffectivePermissions,
	packageResource,
} from '#worker/authorization/authorize.ts'
import { loadOrgBindingForOrg } from '#worker/orgs/repo.ts'
import { deriveRequestContext } from '#worker/request-context/request-context.ts'

/**
 * Whether a signed-in person may open the owner view of a saved package on
 * `/@owner/<kody-id>` (details, source files, private icon). The person must
 * belong to (or hold a grant in) the org that owns the package and hold
 * `package:read` on it there, the same check as `packageGet`. The signup org
 * owner reads every package it owns; team org members read what their role,
 * teams, and grants give them. An execute-only grant lists the package but
 * does not open its source.
 */
export async function viewerCanReadSavedPackage(input: {
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
	return checkPermission(
		access,
		'package:read',
		packageResource({ id: input.packageId, userId: input.ownerId }),
	).allowed
}
