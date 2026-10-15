import { type AuthenticatedAppUser } from '#app/authenticated-user.ts'
import {
	type AccountInviteLinkSummary,
	type AccountOrganizationSummary,
} from '#universal/loader-data.ts'
import { orgRoleLabel } from '#universal/org-pages.ts'
import { packageCollaboratorPresetLabel } from '#universal/package-collaborators.ts'
import {
	listPendingInviteLinksForPerson,
	type PendingInviteLinkSummary,
} from '#worker/orgs/invite-link-pending.ts'
import { buildOrgAvatarUrl } from '#worker/orgs/org-avatar.ts'
import {
	listOrganizationsForPerson,
	listPendingInvitesForPerson,
	type PendingInviteSummary,
} from '#worker/orgs/repo.ts'

export type AccountOrganizationSnapshot = {
	organizations: Array<AccountOrganizationSummary>
	inviteCount: number
	invites: Array<PendingInviteSummary>
	inviteLinks: Array<AccountInviteLinkSummary>
}

function inviteLinkLabel(link: PendingInviteLinkSummary) {
	const target = link.target
	switch (target.kind) {
		case 'membership':
			return `Join as ${orgRoleLabel(target.role)}`
		case 'team':
			return `Join the ${link.teamName ?? 'team'} team`
		case 'resource':
			return `${packageCollaboratorPresetLabel(target.preset)} access to ${link.packageName ?? 'a package'}`
		default: {
			const exhaustive: never = target
			throw new Error(`Unknown invite link target: ${String(exhaustive)}`)
		}
	}
}

function toInviteLinkSummary(
	link: PendingInviteLinkSummary,
): AccountInviteLinkSummary {
	return {
		linkId: link.linkId,
		orgSlug: link.orgSlug,
		orgDisplayName: link.orgDisplayName,
		orgPersonal: link.orgPersonal,
		kind: link.target.kind,
		label: inviteLinkLabel(link),
		expiresAt: link.expiresAt,
	}
}

export async function loadAccountOrganizationSnapshot(
	env: Env,
	user: Pick<AuthenticatedAppUser, 'email' | 'username' | 'mcpUser'>,
): Promise<AccountOrganizationSnapshot> {
	const now = new Date().toISOString()
	const identity = {
		email: user.email,
		username: user.username,
		now,
	}
	const [organizations, invites, inviteLinks] = await Promise.all([
		listOrganizationsForPerson(env.APP_DB, user.mcpUser.userId),
		listPendingInvitesForPerson(env.APP_DB, identity),
		listPendingInviteLinksForPerson(env.APP_DB, {
			userId: user.mcpUser.userId,
			now,
		}),
	])
	return {
		organizations: organizations.map((org) => ({
			slug: org.slug,
			displayName: org.displayName,
			role: org.role,
			personal: org.personal,
			avatarUrl: org.personal
				? null
				: buildOrgAvatarUrl({ slug: org.slug, avatarKey: org.avatarKey }),
		})),
		inviteCount: invites.length + inviteLinks.length,
		invites,
		inviteLinks: inviteLinks.map(toInviteLinkSummary),
	}
}
