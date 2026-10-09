/**
 * soft-delete-read-filter: opt-out
 */

import { offboardOrgMember } from '#worker/orgs/offboarding.ts'
import { resolveOAuthHelpers } from '#worker/oauth-helpers.ts'
import { type OAuthGrantHelpers } from '#worker/oauth-grants.ts'

export type MemberSoftRemovedInput = {
	env: Env
	orgId: string
	userId: string
	deletedAt: string
}

/**
 * Soft-delete membership side effects when a user is removed or leaves:
 * credentials, own-login integrations, and job keep-running (voluntary leave).
 */
export async function onMemberSoftRemoved(
	input: MemberSoftRemovedInput,
): Promise<void> {
	const oauthHelpers = (await resolveOAuthHelpers(input.env)) as
		| OAuthGrantHelpers
		| undefined
	await offboardOrgMember({
		appDb: input.env.APP_DB,
		env: input.env,
		orgId: input.orgId,
		memberUserId: input.userId,
		memberLeftVoluntarily: true,
		now: new Date(input.deletedAt),
		oauthHelpers: oauthHelpers ?? null,
	})
}
