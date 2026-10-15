import { type Action } from 'remix/router'
import { z } from 'zod'
import { readAuthenticatedAppUser } from '#app/authenticated-user.ts'
import { isMcpCallerError } from '#mcp/caller-error.ts'
import {
	inviteCreateCapability,
	inviteRevokeCapability,
} from '#mcp/capabilities/access/invites.ts'
import {
	packageCollaboratorRemoveCapability,
	packageCollaboratorSetCapability,
} from '#mcp/capabilities/access/package-collaborators.ts'
import { type CapabilityContext } from '#mcp/capabilities/types.ts'
import { createMcpCallerContext } from '#mcp/context.ts'
import { getAppBaseUrl } from '#worker/app-base-url.ts'
import {
	AuthorizationError,
	checkPermission,
	computeEffectivePermissions,
	packageResource,
} from '#worker/authorization/authorize.ts'
import { jsonResponse } from '#worker/json-response.ts'
import { getInviteById } from '#worker/orgs/access-writes.ts'
import { isPersonalOrg } from '#worker/orgs/is-personal-org.ts'
import {
	listPackageCollaborators,
	listPendingPackageInvites,
} from '#worker/orgs/package-collaborators.ts'
import { loadOrgBindingForSlug, type OrgBinding } from '#worker/orgs/repo.ts'
import { resolveSavedPackage } from '#worker/package-invocations/module-artifacts.ts'
import {
	type PackageCollaboratorInviteCreated,
	type PackageCollaboratorsView,
	type PackageCollaboratorsWriteResult,
	packageCollaboratorInviteeLabel,
	packageCollaboratorPresets,
	readPackageCollaboratorInvitee,
} from '#universal/package-collaborators.ts'
import { type routes } from '#universal/routes.ts'

type AppUser = NonNullable<Awaited<ReturnType<typeof readAuthenticatedAppUser>>>

type CollaboratorsScope = {
	ctx: CapabilityContext
	org: OrgBinding['org']
	orgSlug: string
	personal: boolean
	savedPackage: { id: string; kodyId: string; name: string }
}

const presetSchema = z.enum(packageCollaboratorPresets)

const changeSchema = z.discriminatedUnion('intent', [
	z.strictObject({
		intent: z.literal('grant'),
		subjectType: z.enum(['user', 'team']),
		subjectId: z.string().trim().min(1),
		preset: presetSchema,
	}),
	z.strictObject({
		intent: z.literal('revoke'),
		grantId: z.string().trim().min(1),
	}),
	z.strictObject({
		intent: z.literal('invite'),
		invitee: z.string().trim().min(1),
		preset: presetSchema,
	}),
	z.strictObject({
		intent: z.literal('revoke-invite'),
		inviteId: z.string().trim().min(1),
	}),
])

class CollaboratorChangeRefused extends Error {
	readonly status: 400 | 404
	constructor(message: string, status: 400 | 404 = 400) {
		super(message)
		this.status = status
	}
}

/**
 * The package as the signed-in person sees it, bound to the `:username` org
 * (members and outside collaborators alike). Not found when they cannot read
 * the package there; forbidden when they can read it but not manage access.
 */
async function loadCollaboratorsScope(input: {
	env: Env
	request: Request
	user: AppUser
	username: string
	kodyId: string
}): Promise<
	| { kind: 'ok'; scope: CollaboratorsScope }
	| { kind: 'not_found' }
	| { kind: 'forbidden' }
> {
	const { env, user } = input
	const binding = await loadOrgBindingForSlug(
		env.APP_DB,
		user.mcpUser.userId,
		input.username,
	)
	if (!binding) return { kind: 'not_found' }
	const savedPackage = await resolveSavedPackage({
		db: env.APP_DB,
		userId: binding.org.id,
		packageIdOrKodyId: input.kodyId.trim(),
	})
	if (!savedPackage) return { kind: 'not_found' }
	const callerContext = createMcpCallerContext({
		baseUrl: getAppBaseUrl({ env, requestUrl: input.request.url }),
		source: { kind: 'session' },
		executionOrigin: 'interactive',
		user: user.mcpUser,
		orgBinding: binding,
	})
	if (!callerContext.request) return { kind: 'not_found' }
	const access = await computeEffectivePermissions({
		env,
		request: callerContext.request,
	})
	const resource = packageResource({
		id: savedPackage.id,
		userId: savedPackage.userId,
		label: savedPackage.kodyId,
	})
	if (!checkPermission(access, 'package:read', resource).allowed) {
		return { kind: 'not_found' }
	}
	if (!checkPermission(access, 'package:manage_access', resource).allowed) {
		return { kind: 'forbidden' }
	}
	return {
		kind: 'ok',
		scope: {
			ctx: { env, callerContext },
			org: binding.org,
			orgSlug: binding.org.slug ?? input.username,
			personal: await isPersonalOrg(env.APP_DB, binding.org.id),
			savedPackage: {
				id: savedPackage.id,
				kodyId: savedPackage.kodyId,
				name: savedPackage.name,
			},
		},
	}
}

async function buildCollaboratorsView(
	scope: CollaboratorsScope,
): Promise<PackageCollaboratorsView> {
	const db = scope.ctx.env.APP_DB
	const target = { db, orgId: scope.org.id, packageId: scope.savedPackage.id }
	const [listed, invites] = await Promise.all([
		listPackageCollaborators(target),
		scope.personal ? listPendingPackageInvites(target) : Promise.resolve([]),
	])
	return {
		ok: true,
		package: scope.savedPackage,
		org: { slug: scope.orgSlug, personal: scope.personal },
		collaborators: listed.collaborators,
		invites,
		options: listed.options,
	}
}

function requirePersonalOrg(scope: CollaboratorsScope) {
	if (scope.personal) return
	throw new CollaboratorChangeRefused(
		'Invites from this tab are for personal organizations. In a team organization, add teams and members instead.',
	)
}

async function applyChange(
	scope: CollaboratorsScope,
	change: z.infer<typeof changeSchema>,
): Promise<PackageCollaboratorInviteCreated | null> {
	const { ctx, savedPackage } = scope
	const intent = change.intent
	switch (intent) {
		case 'grant':
			await packageCollaboratorSetCapability.handler(
				{
					package_id: savedPackage.id,
					...(change.subjectType === 'team'
						? { team_id: change.subjectId }
						: { user_id: change.subjectId }),
					preset: change.preset,
				},
				ctx,
			)
			return null
		case 'revoke':
			await packageCollaboratorRemoveCapability.handler(
				{ package_id: savedPackage.id, grant_id: change.grantId },
				ctx,
			)
			return null
		case 'invite': {
			requirePersonalOrg(scope)
			const created = await inviteCreateCapability.handler(
				{
					kind: 'grant',
					...readPackageCollaboratorInvitee(change.invitee),
					resource_type: 'package',
					resource_id: savedPackage.id,
					preset: change.preset,
				},
				ctx,
			)
			return {
				expiresAt: created.invite.expires_at,
				inviteeLabel: packageCollaboratorInviteeLabel({
					inviteeEmail: created.invite.invitee_email,
					inviteeUsername: created.invite.invitee_username,
				}),
				preset: change.preset,
				prompt: created.prompt,
			}
		}
		case 'revoke-invite': {
			requirePersonalOrg(scope)
			const invite = await getInviteById({
				db: ctx.env.APP_DB,
				orgId: scope.org.id,
				inviteId: change.inviteId,
			})
			if (
				!invite ||
				invite.kind !== 'grant' ||
				invite.resourceType !== 'package' ||
				invite.resourceId !== savedPackage.id ||
				invite.status !== 'pending'
			) {
				throw new CollaboratorChangeRefused(
					'That invite is no longer pending.',
					404,
				)
			}
			await inviteRevokeCapability.handler({ invite_id: invite.id }, ctx)
			return null
		}
		default: {
			const exhaustive: never = intent
			throw new Error(`Unknown collaborator change: ${String(exhaustive)}`)
		}
	}
}

/**
 * `/profiles/:username/packages/:kodyId/collaborators.json`: the package
 * Collaborators tab. GET returns the `PackageCollaboratorsView`; POST one
 * `PackageCollaboratorsChange` and get the updated view back (plus the invite
 * prompt, once, after an invite). Writes go through `packageCollaboratorSet`,
 * `packageCollaboratorRemove`, `inviteCreate`, and `inviteRevoke`, the same
 * capabilities the Open API exposes, so they are authorized and audited alike.
 */
export function createPackageCollaboratorsApiHandler(env: Env) {
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
						error:
							'You need Manage on this package to see and change who can use it.',
					},
					403,
				)
			}
			const { scope } = loaded
			if (request.method === 'GET') {
				return jsonResponse(await buildCollaboratorsView(scope))
			}
			const parsed = changeSchema.safeParse(
				await request.json().catch(() => null),
			)
			if (!parsed.success) {
				return jsonResponse(
					{
						ok: false,
						error: `Invalid request body: ${parsed.error.issues[0]?.message ?? 'expected one change'}.`,
					},
					400,
				)
			}
			let invite: PackageCollaboratorInviteCreated | null
			try {
				invite = await applyChange(scope, parsed.data)
			} catch (error) {
				if (error instanceof CollaboratorChangeRefused) {
					return jsonResponse({ ok: false, error: error.message }, error.status)
				}
				if (error instanceof AuthorizationError) {
					return jsonResponse({ ok: false, error: error.message }, 403)
				}
				if (isMcpCallerError(error) && error instanceof Error) {
					return jsonResponse({ ok: false, error: error.message }, 400)
				}
				throw error
			}
			const view = await buildCollaboratorsView(scope)
			return jsonResponse(
				(invite
					? { ...view, invite }
					: view) satisfies PackageCollaboratorsWriteResult,
			)
		},
	} satisfies Action<
		| typeof routes.communityPackageCollaboratorsApi
		| typeof routes.communityPackageCollaboratorsApiPost
	>
}
