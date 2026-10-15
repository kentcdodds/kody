/**
 * The one door for using an org credential: `resolveCredential`.
 *
 * Every runtime site that turns a credential reference into usable material
 * calls this function, and credential storage (secret values, OAuth tokens,
 * vault door keys, MCP hub tool calls) is read nowhere else but the door and
 * its resolvers (`credential-storage-boundary.node.test.ts` enforces that).
 * Each call:
 *
 * 1. checks that the acting person still has access to the org (live
 *    membership, team, or outside-collaborator grant, org not deleted or
 *    suspended), so access that ended without a cascade cannot resolve;
 * 2. asks the credential kind's resolver (`credential-resolver.ts`) to find
 *    the credential by metadata, with no decrypt;
 * 3. authorizes the use: the actor's Use on the credential's stable id,
 *    whatever the package stamp, then the package rules (secret allowlists,
 *    integration and MCP usage modes, vault provider grants) and, where the
 *    metadata has them, allowed hosts. A renamed credential keeps its grants
 *    and a deleted then recreated name starts with none. A trigger acts as its
 *    enabler, so it needs the enabler's own Use, and a denial pauses that
 *    enablement;
 * 4. only then applies the credential, the one step that reads storage;
 * 5. schedules exactly one `credential.resolve` org audit row for every
 *    outcome (success, not found, denied, failed), for every kind of actor.
 *    The row never holds the credential value.
 *
 * A request with no acting person holds no permissions. The only path with
 * no request at all is webhook ingress verifying a signature, which passes an
 * attested package stamp.
 */
import { type RequestContext } from '@kody-internal/shared/request-context.ts'
import { AuthorizationError } from '#worker/authorization/authorize.ts'
import { pauseEnablementOnDenial } from '#worker/enablements/pause-on-denial.ts'
import { loadOrgBindingForOrg } from '#worker/orgs/repo.ts'
import { enablementIdOf } from '#worker/request-context/request-context.ts'
import {
	credentialResolutionOutcomeForError,
	scheduleCredentialResolutionAudit,
	type CredentialResolutionOutcome,
} from './credential-resolution-audit.ts'
import {
	clientKeyResolver,
	clientOauthRefreshResolver,
	clientOauthResolver,
} from './client-resolver.ts'
import {
	permissionForUse,
	type CredentialResolver,
	type CredentialTarget,
	type CredentialTargetFor,
	type CredentialUse,
	type ResolveCredentialInput,
	type ResolvedCredential,
} from './credential-resolver.ts'
import { loginCredentialResolver } from './login-resolver.ts'
import { mcpConnectionResolver } from './mcp-resolver.ts'
import {
	integrationRefreshResolver,
	integrationTokenResolver,
} from './oauth-resolvers.ts'
import {
	packageSecretMountResolver,
	secretResolver,
	vaultSecretResolver,
	webhookSecretResolver,
} from './secret-resolvers.ts'
import { assertSelfPublishedPackageResolvesNothing } from './self-published-package-guard.ts'
import { signingCredentialResolver } from './signing-resolver.ts'
import { urlCredentialResolver } from './url-resolver.ts'

const credentialResolvers: {
	[U in CredentialUse]: CredentialResolver<U>
} = {
	secret: secretResolver,
	'package-secret-mount': packageSecretMountResolver,
	'webhook-secret': webhookSecretResolver,
	'provider-secret': vaultSecretResolver,
	'integration-token': integrationTokenResolver,
	'integration-refresh': integrationRefreshResolver,
	'mcp-connection': mcpConnectionResolver,
	url: urlCredentialResolver,
	login: loginCredentialResolver,
	signing: signingCredentialResolver,
	'client-key': clientKeyResolver,
	'client-oauth': clientOauthResolver,
	'client-oauth-refresh': clientOauthRefreshResolver,
}

export async function resolveCredential<T extends CredentialTarget>(
	input: ResolveCredentialInput<T>,
): Promise<ResolvedCredential<T>> {
	return await resolveWith(
		credentialResolvers[input.credential.use] as CredentialResolver<T['use']>,
		input,
	)
}

async function resolveWith<U extends CredentialUse>(
	resolver: CredentialResolver<U>,
	input: ResolveCredentialInput<CredentialTarget>,
) {
	const credential = input.credential as CredentialTargetFor<U>
	const subject = resolver.auditSubject(credential)
	const audit = (outcome: CredentialResolutionOutcome) =>
		scheduleCredentialResolutionAudit({
			env: input.env,
			orgId: input.orgId,
			actor: input.actor,
			packageStamp: input.packageStamp,
			subject,
			outcome,
		})
	let result
	try {
		await assertActorHasOrgAccess(input)
		await assertSelfPublishedPackageResolvesNothing({
			env: input.env,
			request: input.actor,
			packageId: input.packageStamp?.packageId ?? input.runPackageId,
			credentialName: subject.name,
		})
		const handle = await resolver.resolve({ input, credential, subject })
		await handle.authorize()
		result = await handle.apply()
	} catch (error) {
		audit(credentialResolutionOutcomeForError(error))
		const enablementId = enablementIdOf(input.actor)
		if (enablementId && error instanceof AuthorizationError) {
			await pauseEnablementOnDenial({
				db: input.env.APP_DB,
				orgId: input.orgId,
				enablementId,
				error,
				credentialResourceType: subject.resourceType,
			})
		}
		throw error
	}
	audit(
		resolver.isFound(result)
			? { result: 'success' }
			: { result: 'failure', reason: 'not_found' },
	)
	return result
}

const orgAccessByRequest = new WeakMap<RequestContext, Promise<void>>()

/**
 * Resolve-time org access: re-reads membership, team membership, and grants
 * instead of trusting the role the request was built with. Checked once per
 * request context, like compiled permissions.
 */
async function assertActorHasOrgAccess(
	input: ResolveCredentialInput<CredentialTarget>,
) {
	const request = input.actor
	if (!request) return
	const permission = permissionForUse(input.credential.use)
	if (request.org.id !== input.orgId) {
		throw new AuthorizationError({
			code: 'wrong_org',
			permission,
			orgId: request.org.id,
			resource: null,
			message: 'This credential belongs to another org.',
		})
	}
	const person = request.actor
	if (!person) return
	let check = orgAccessByRequest.get(request)
	if (!check) {
		check = (async () => {
			const hasAccess =
				(await loadOrgBindingForOrg(
					input.env.APP_DB,
					person.userId,
					input.orgId,
				)) !== null
			if (hasAccess) return
			throw new AuthorizationError({
				code: 'wrong_org',
				permission,
				orgId: input.orgId,
				resource: null,
				message:
					'You no longer have access to this org, so its credentials cannot be used.',
			})
		})()
		orgAccessByRequest.set(request, check)
		// Only a definite "no access" is cached; a failed lookup is retried.
		check.catch((error: unknown) => {
			if (!(error instanceof AuthorizationError)) {
				orgAccessByRequest.delete(request)
			}
		})
	}
	await check
}
