import { type Action } from 'remix/router'
import { readAuthenticatedAppUser } from '#app/authenticated-user.ts'
import { McpCallerError } from '#mcp/caller-error.ts'
import {
	acceptAddressedInvite,
	declineAddressedInvite,
} from '#mcp/capabilities/access/invites.ts'
import { jsonResponse } from '#worker/json-response.ts'
import {
	getInviteByIdAnyOrg,
	type StoredInvite,
} from '#worker/orgs/access-writes.ts'
import { FreeOrgLimitError } from '#worker/orgs/billing.ts'
import { orgAuditWriterFromRequest } from '#worker/orgs/org-audit.ts'
import { andLiveDeletedAtSql } from '#worker/soft-delete/live-sql.ts'
import { routes } from '#universal/routes.ts'

type AuthenticatedUser = NonNullable<
	Awaited<ReturnType<typeof readAuthenticatedAppUser>>
>

function readInviteId(params: { inviteId?: unknown }) {
	return typeof params.inviteId === 'string' ? params.inviteId.trim() : ''
}

function notFound() {
	return jsonResponse(
		{ ok: false, error: 'This invite is no longer waiting on you.' },
		404,
	)
}

/**
 * The invite behind a recipient action, or a response to send instead. An
 * invite addressed by email needs that email verified, so signing up with
 * someone else's address does not let you act on their invites.
 */
async function loadRecipientInvite(
	env: Env,
	user: AuthenticatedUser,
	inviteId: string,
): Promise<StoredInvite | Response> {
	const invite = inviteId
		? await getInviteByIdAnyOrg(env.APP_DB, inviteId)
		: null
	if (!invite) return notFound()
	if (invite.inviteeEmail && !user.emailVerified) {
		return jsonResponse(
			{ ok: false, error: 'Verify your email to answer this invite.' },
			403,
		)
	}
	return invite
}

function callerErrorResponse(error: unknown) {
	if (error instanceof McpCallerError || error instanceof FreeOrgLimitError) {
		return jsonResponse({ ok: false, error: error.message }, 400)
	}
	throw error
}

function recipient(user: AuthenticatedUser) {
	return {
		userId: user.mcpUser.userId,
		email: user.email,
		username: user.username,
	}
}

async function redirectAfterAccept(
	db: D1Database,
	invite: StoredInvite,
	orgSlug: string,
) {
	if (
		invite.kind === 'grant' &&
		invite.resourceType === 'package' &&
		invite.resourceId
	) {
		const pkg = await db
			.prepare(
				`SELECT kody_id FROM saved_packages
				 WHERE id = ? AND user_id = ?${andLiveDeletedAtSql()}`,
			)
			.bind(invite.resourceId, invite.orgId)
			.first<{ kody_id: string }>()
		if (pkg) {
			return routes.communityPackage.href({
				username: orgSlug,
				kodyId: pkg.kody_id,
			})
		}
	}
	return `/@${orgSlug}`
}

/** Accept an invite addressed to this person from Waiting or Organizations. */
export function createAccountInviteAcceptPostHandler(env: Env) {
	return {
		middleware: [],
		async handler({ request, params }) {
			const user = await readAuthenticatedAppUser(request, env)
			if (!user) {
				return jsonResponse({ ok: false, error: 'Unauthorized.' }, 401)
			}
			const invite = await loadRecipientInvite(env, user, readInviteId(params))
			if (invite instanceof Response) return invite
			try {
				const org = await acceptAddressedInvite({
					db: env.APP_DB,
					env,
					invite,
					user: recipient(user),
					audit: orgAuditWriterFromRequest(env, user.request),
				})
				return jsonResponse({
					ok: true,
					redirectTo: await redirectAfterAccept(env.APP_DB, invite, org.slug),
				})
			} catch (error) {
				return callerErrorResponse(error)
			}
		},
	} satisfies Action<typeof routes.accountInviteAcceptPost>
}

export function createAccountInviteDeclinePostHandler(env: Env) {
	return {
		middleware: [],
		async handler({ request, params }) {
			const user = await readAuthenticatedAppUser(request, env)
			if (!user) {
				return jsonResponse({ ok: false, error: 'Unauthorized.' }, 401)
			}
			const invite = await loadRecipientInvite(env, user, readInviteId(params))
			if (invite instanceof Response) return invite
			try {
				await declineAddressedInvite({
					db: env.APP_DB,
					invite,
					user: recipient(user),
					audit: orgAuditWriterFromRequest(env, user.request),
				})
				return jsonResponse({ ok: true })
			} catch (error) {
				return callerErrorResponse(error)
			}
		},
	} satisfies Action<typeof routes.accountInviteDeclinePost>
}
