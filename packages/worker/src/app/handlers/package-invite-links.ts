import { type Action } from 'remix/router'
import { readAuthenticatedAppUser } from '#app/authenticated-user.ts'
import { loadCollaboratorsScope } from '#app/handlers/package-collaborators.ts'
import {
	inviteLinkUrl,
	readInviteLinkOptions,
} from '#app/invite-link-options.ts'
import { jsonResponse } from '#worker/json-response.ts'
import {
	createOrgInviteLink,
	generateInviteLinkToken,
	hashInviteLinkToken,
	isInviteLinkResourcePreset,
	listActiveOrgInviteLinks,
	revokeOrgInviteLink,
	type InviteLinkScope,
	type ListedInviteLink,
} from '#worker/orgs/invite-links.ts'
import { orgAuditWriterFromRequest } from '#worker/orgs/org-audit.ts'
import {
	type PackageInviteLinksView,
	type ScopedInviteLinkView,
} from '#universal/loader-data.ts'
import { packageCollaboratorPresetLabel } from '#universal/package-collaborators.ts'
import { type routes } from '#universal/routes.ts'

async function readJsonObject(request: Request) {
	const body = await request.json().catch(() => null)
	if (!body || typeof body !== 'object') return null
	return body as Record<string, unknown>
}

function toView(link: ListedInviteLink): Array<ScopedInviteLinkView> {
	if (link.target.kind !== 'resource') return []
	return [
		{
			id: link.id,
			label: packageCollaboratorPresetLabel(link.target.preset),
			teamId: null,
			maxUses: link.maxUses,
			useCount: link.useCount,
			expiresAt: link.expiresAt,
			createdByUsername: link.createdByUsername,
			createdByDisplayName: link.createdByDisplayName,
		},
	]
}

async function listView(
	db: D1Database,
	orgId: string,
	scope: InviteLinkScope,
): Promise<PackageInviteLinksView> {
	const links = await listActiveOrgInviteLinks(
		db,
		orgId,
		new Date().toISOString(),
		scope,
	)
	return { ok: true, links: links.flatMap(toView) }
}

/**
 * `/profiles/:username/packages/:kodyId/invite-links.json`: shareable links
 * on the package Collaborators tab. GET lists active links for the package;
 * POST `{ action: 'create', preset, maxUses?, expiresInDays? }` returns the
 * URL once, POST `{ action: 'revoke', linkId }` revokes one. Same access as
 * the Collaborators tab (package:manage_access), and works in personal orgs.
 */
export function createPackageInviteLinksApiHandler(env: Env) {
	return {
		middleware: [],
		async handler({ request, params }) {
			if (request.method !== 'GET' && request.method !== 'POST') {
				return jsonResponse(
					{ ok: false, error: 'Method not allowed.' },
					{ status: 405, headers: { Allow: 'GET, POST' } },
				)
			}
			const user = await readAuthenticatedAppUser(request, env)
			if (!user) {
				return jsonResponse({ ok: false, error: 'Unauthorized.' }, 401)
			}
			const loaded = await loadCollaboratorsScope({
				env,
				request,
				user,
				username: params.username,
				kodyId: params.kodyId,
			})
			if (loaded.kind === 'not_found') {
				return jsonResponse({ ok: false, error: 'Package not found.' }, 404)
			}
			if (loaded.kind === 'forbidden') {
				return jsonResponse(
					{
						ok: false,
						error: 'You need Manage on this package to share it with a link.',
					},
					403,
				)
			}
			const { scope } = loaded
			const db = env.APP_DB
			const linkScope: InviteLinkScope = {
				kind: 'resource',
				resourceType: 'package',
				resourceId: scope.savedPackage.id,
			}
			if (request.method === 'GET') {
				return jsonResponse(await listView(db, scope.org.id, linkScope))
			}
			const body = await readJsonObject(request)
			const action = body?.action
			if (action === 'revoke') {
				const linkId =
					typeof body?.linkId === 'string' ? body.linkId.trim() : ''
				if (!linkId) {
					return jsonResponse(
						{ ok: false, error: 'An invite link is required.' },
						400,
					)
				}
				try {
					await revokeOrgInviteLink({
						db,
						orgId: scope.org.id,
						linkId,
						scope: linkScope,
						audit: orgAuditWriterFromRequest(env, user.request),
					})
				} catch (error) {
					return jsonResponse(
						{
							ok: false,
							error:
								error instanceof Error
									? error.message
									: 'Unable to revoke that invite link.',
						},
						400,
					)
				}
				return jsonResponse(await listView(db, scope.org.id, linkScope))
			}
			if (action !== 'create') {
				return jsonResponse(
					{ ok: false, error: 'Choose create or revoke.' },
					400,
				)
			}
			if (!isInviteLinkResourcePreset(body?.preset)) {
				return jsonResponse(
					{ ok: false, error: 'Choose Use, Contribute, or Manage.' },
					400,
				)
			}
			const preset = body.preset
			const parsedOptions = readInviteLinkOptions(body)
			if (!parsedOptions.ok) {
				return jsonResponse({ ok: false, error: parsedOptions.error }, 400)
			}
			const { allowedEmailDomains, maxUses, expiresAt } = parsedOptions.options
			const token = generateInviteLinkToken()
			const tokenHash = await hashInviteLinkToken(token)
			try {
				const created = await createOrgInviteLink({
					db,
					orgId: scope.org.id,
					target: {
						kind: 'resource',
						resourceType: 'package',
						resourceId: scope.savedPackage.id,
						preset,
					},
					createdByUserId: user.mcpUser.userId,
					tokenHash,
					allowedEmailDomains,
					maxUses,
					expiresAt,
					audit: orgAuditWriterFromRequest(env, user.request),
				})
				return jsonResponse({
					...(await listView(db, scope.org.id, linkScope)),
					inviteLink: {
						id: created.id,
						expiresAt: created.expiresAt,
						maxUses: created.maxUses,
						preset,
						url: inviteLinkUrl(request, token),
					},
				})
			} catch (error) {
				return jsonResponse(
					{
						ok: false,
						error:
							error instanceof Error
								? error.message
								: 'Unable to create that invite link.',
					},
					400,
				)
			}
		},
	} satisfies Action<
		| typeof routes.communityPackageInviteLinksApi
		| typeof routes.communityPackageInviteLinksApiPost
	>
}
