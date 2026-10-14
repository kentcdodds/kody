import { type Action } from 'remix/router'
import { z } from 'zod'
import { readAuthenticatedAppUser } from '#app/authenticated-user.ts'
import { isMcpCallerError } from '#mcp/caller-error.ts'
import {
	accessGrantCapability,
	accessRevokeCapability,
} from '#mcp/capabilities/access/access-grants.ts'
import {
	inviteCreateCapability,
	inviteRevokeCapability,
} from '#mcp/capabilities/access/invites.ts'
import { type CapabilityContext } from '#mcp/capabilities/types.ts'
import { createMcpCallerContext } from '#mcp/context.ts'
import { getAppBaseUrl } from '#worker/app-base-url.ts'
import {
	AuthorizationError,
	checkPermission,
	computeEffectivePermissions,
	packageResource,
} from '#worker/authorization/authorize.ts'
import { normalizeEmailAddress } from '#worker/email/address.ts'
import { jsonResponse } from '#worker/json-response.ts'
import {
	getGrantById,
	getInviteById,
	listGrants,
} from '#worker/orgs/access-writes.ts'
import { isPersonalOrg } from '#worker/orgs/is-personal-org.ts'
import { getLiveOrgMembership } from '#worker/orgs/org-members-list.ts'
import { listPackageCollaborators } from '#worker/orgs/package-collaborators.ts'
import { loadOrgBindingForSlug, type OrgBinding } from '#worker/orgs/repo.ts'
import { resolveSavedPackage } from '#worker/package-invocations/module-artifacts.ts'
import {
	type PackageCollaboratorsView,
	type PackageCollaboratorsWriteResult,
	packageCollaboratorPresets,
} from '#universal/package-collaborators.ts'
import { type routes } from '#universal/routes.ts'

type AppUser = NonNullable<Awaited<ReturnType<typeof readAuthenticatedAppUser>>>

type CollaboratorsScope = {
	ctx: CapabilityContext
	org: OrgBinding['org']
	orgSlug: string
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
	const [listed, personal] = await Promise.all([
		listPackageCollaborators({
			db,
			orgId: scope.org.id,
			packageId: scope.savedPackage.id,
		}),
		isPersonalOrg(db, scope.org.id),
	])
	return {
		ok: true,
		package: scope.savedPackage,
		org: { slug: scope.orgSlug, personal },
		...listed,
	}
}

/** An email address, or a username with or without its leading `@`. */
function readInvitee(value: string) {
	if (/^[^@\s]+@[^@\s]+$/.test(value)) {
		const email = normalizeEmailAddress(value)
		if (!email) throw new CollaboratorChangeRefused('Enter a valid email.')
		return { email }
	}
	return { username: value.replace(/^@/, '') }
}

async function applyChange(
	scope: CollaboratorsScope,
	change: z.infer<typeof changeSchema>,
): Promise<PackageCollaboratorsWriteResult['invite']> {
	const { ctx, org, savedPackage } = scope
	const db = ctx.env.APP_DB
	const intent = change.intent
	switch (intent) {
		case 'grant': {
			if (change.subjectType === 'user') {
				// Members are added directly; anyone else needs an invite. A person
				// who already holds a grant here can have their preset changed.
				const [membership, existing] = await Promise.all([
					getLiveOrgMembership(db, org.id, change.subjectId),
					listGrants({
						db,
						orgId: org.id,
						resourceType: 'package',
						resourceId: savedPackage.id,
						subjectType: 'user',
						subjectId: change.subjectId,
					}),
				])
				if (!membership && existing.length === 0) {
					throw new CollaboratorChangeRefused(
						'That person is not a member of this organization. Invite them by email or username instead.',
					)
				}
			}
			await accessGrantCapability.handler(
				{
					resource_type: 'package',
					resource_id: savedPackage.id,
					subject_type: change.subjectType,
					subject_id: change.subjectId,
					preset: change.preset,
				},
				ctx,
			)
			return undefined
		}
		case 'revoke': {
			const grant = await getGrantById({
				db,
				orgId: org.id,
				grantId: change.grantId,
			})
			if (
				!grant ||
				grant.resourceType !== 'package' ||
				grant.resourceId !== savedPackage.id
			) {
				throw new CollaboratorChangeRefused(
					'That collaborator no longer has access to this package.',
					404,
				)
			}
			await accessRevokeCapability.handler({ grant_id: grant.id }, ctx)
			return undefined
		}
		case 'invite': {
			const invitee = readInvitee(change.invitee)
			const created = await inviteCreateCapability.handler(
				{
					kind: 'grant',
					...invitee,
					resource_type: 'package',
					resource_id: savedPackage.id,
					preset: change.preset,
				},
				ctx,
			)
			return {
				id: created.invite.id,
				expiresAt: created.invite.expires_at,
				token: created.token,
				prompt: created.prompt,
			}
		}
		case 'revoke-invite': {
			const invite = await getInviteById({
				db,
				orgId: org.id,
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
			return undefined
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
 * token and prompt, once, after an invite). Writes go through the same
 * capability handlers as `accessGrant`, `accessRevoke`, `inviteCreate`, and
 * `inviteRevoke`, so they are authorized and audited the same way.
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
			let invite: PackageCollaboratorsWriteResult['invite']
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
