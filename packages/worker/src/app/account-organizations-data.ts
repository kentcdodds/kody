import { type AuthenticatedAppUser } from '#app/authenticated-user.ts'
import {
	listOrganizationsForPerson,
	listPendingInvitesForPerson,
	type ListedOrganization,
	type PendingInviteSummary,
} from '#worker/orgs/repo.ts'
import { readLastUsedOrgSlug } from '#universal/org-last-used-cookie.ts'

export type AccountOrganizationSnapshot = {
	organizations: Array<ListedOrganization>
	inviteCount: number
	lastUsedOrganization: string | null
	invites: Array<PendingInviteSummary>
}

export async function loadAccountOrganizationSnapshot(
	env: Env,
	user: Pick<AuthenticatedAppUser, 'email' | 'username' | 'mcpUser'>,
	request: Request,
): Promise<AccountOrganizationSnapshot> {
	const now = new Date().toISOString()
	const identity = {
		email: user.email,
		username: user.username,
		now,
	}
	const [organizations, invites] = await Promise.all([
		listOrganizationsForPerson(env.APP_DB, user.mcpUser.userId),
		listPendingInvitesForPerson(env.APP_DB, identity),
	])
	const remembered = readLastUsedOrgSlug(request.headers.get('cookie'))
	const lastUsedOrganization = organizations.some(
		(org) => org.slug === remembered,
	)
		? remembered
		: null
	return {
		organizations,
		inviteCount: invites.length,
		lastUsedOrganization,
		invites,
	}
}
