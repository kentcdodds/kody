/**
 * The one door for using an org credential: `resolveCredential`.
 *
 * Every runtime site that turns a credential reference into usable material
 * calls this function, and credential storage (secret values, OAuth tokens,
 * vault door keys, MCP hub tool calls) is read nowhere else
 * (`credential-storage-boundary.node.test.ts` enforces that). Each call:
 *
 * 1. checks that the acting person still has access to the org (live
 *    membership, team, or outside-collaborator grant, org not deleted or
 *    suspended), so access that ended without a cascade cannot resolve;
 * 2. requires the actor's per-credential Use unless the package stamp is
 *    attested (see `PackageStamp`). An enablement run (a trigger acting as
 *    its enabler) always needs the enabler's own Use, attested or not, and a
 *    denial pauses that enablement;
 * 3. applies the package rules for that use (secret allowlists, integration
 *    and MCP usage modes, vault provider grants), then reads storage;
 * 4. schedules exactly one `credential.resolve` org audit row for every
 *    outcome (success, not found, denied, failed), for every kind of actor.
 *    The row never holds the credential value.
 *
 * Legacy Automation (a request with no acting person, in an org not yet
 * moved to enablements) acts as Owner. Platform paths with no request at all
 * (webhook ingress) pass an attested package stamp.
 */
import { type McpCallerContext } from '@kody-internal/shared/chat.ts'
import { type OrgPermission } from '@kody-internal/shared/org-permissions.ts'
import { type OwnerId } from '@kody-internal/shared/owner-person-ids.ts'
import { type RequestContext } from '@kody-internal/shared/request-context.ts'
import { type CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import {
	AuthorizationError,
	authorize,
	type OrgResource,
} from '#worker/authorization/authorize.ts'
import {
	createMissingIntegrationAccessTokenMessage,
	resolveIntegrationAccessToken,
} from '#worker/integrations/credentials.ts'
import { assertCanUseIntegration } from '#worker/integrations/package-access.ts'
import { getJoinedIntegration } from '#worker/integrations/service.ts'
import {
	refreshIntegrationTokens,
	type IntegrationTokenRefreshResult,
} from '#worker/integrations/token-refresh.ts'
import { callMcpServerTool } from '#worker/mcp-client/hub-client.ts'
import { assertCanUseMcpServer } from '#worker/mcp-client/package-access.ts'
import { pauseEnablementOnDenial } from '#worker/enablements/pause-on-denial.ts'
import { isOrgActive, loadOrgBindingForOrg } from '#worker/orgs/repo.ts'
import { enablementIdOf } from '#worker/request-context/request-context.ts'
import { assertIntegrationAllowsHost } from '#mcp/execute-modules/integration-host-allowlist.ts'
import { SecretHostNotApprovedError } from '#mcp/secrets/errors.ts'
import {
	assertPackageCanAccessResolvedSecret,
	loadPackageSecretMounts,
	PackageSecretMissingError,
	PackageSecretMountError,
} from '#mcp/secrets/package-access.ts'
import { secretPageOrgSlugFromCaller } from '#mcp/secrets/package-approval-url.ts'
import { buildSecretPlaceholder } from '#mcp/secrets/placeholders.ts'
import {
	createProviderHostDeniedMessage,
	createProviderNoWebsitesMessage,
	SecretProviderHostDeniedError,
} from '#mcp/secrets/secret-providers/errors.ts'
import { providerHostsAllowRequestHost } from '#mcp/secrets/secret-providers/hosts.ts'
import { invokeSealedSecretProvider } from '#mcp/secrets/secret-providers/sealed-invoke.ts'
import {
	getSecretProviderBinding,
	normalizeProviderId,
	resolveProviderSecret,
} from '#mcp/secrets/secret-providers/service.ts'
import { type ResolvedProviderSecret } from '#mcp/secrets/secret-providers/types.ts'
import { resolveSecret, type ResolvedSecret } from '#mcp/secrets/service.ts'
import { type SecretScope } from '#mcp/secrets/types.ts'
import { createUnresolvedSecretMessage } from '#mcp/secrets/unresolved-secret.ts'
import { type StorageContext } from '#mcp/storage.ts'
import {
	credentialResolutionOutcomeForError,
	scheduleCredentialResolutionAudit,
	type CredentialAuditSubject,
	type CredentialResolutionOutcome,
} from './credential-resolution-audit.ts'
import { type PackageStamp } from './package-stamp.ts'

/**
 * Normalized host the value is about to be sent to. When set, the door
 * enforces the credential's host allowlist, so an unapproved host is an
 * audited denial instead of a successful resolution the caller then rejects.
 * Only pass a host that placeholder expansion cannot change.
 */
type RequestHost = string | null

/** What is being resolved. `use` picks the package rules that apply. */
export type CredentialTarget =
	/** `{{secret:…}}` / `secret-basic` placeholders and `secretJwtSign`. */
	| {
			use: 'secret'
			name: string
			scope?: SecretScope | null
			storageContext: StorageContext
			/** Org slug for approval links in denial messages. */
			orgSlug?: string | null
			requestHost?: RequestHost
	  }
	/** `packageSecrets.get` / `.has`: a declared `kody.secretMounts` alias. */
	| {
			use: 'package-secret-mount'
			alias: string
			callerContext: McpCallerContext
	  }
	/**
	 * Webhook `verification.secretName`, challenge `secretName`, and the apply
	 * `destination.secretName`. Read in the stamped package's buckets.
	 */
	| { use: 'webhook-secret'; name: string }
	/** `{{secret/provider:ref}}` vault references. */
	| {
			use: 'provider-secret'
			provider: string
			ref: string
			storageContext: StorageContext
			requestHost?: RequestHost
	  }
	/** `{{integration-token:…}}` and webhook apply integration auth. */
	| {
			use: 'integration-token'
			name: string
			packageKodyId?: string | null
			requestHost?: RequestHost
	  }
	/** `integrationTokenRefresh` and webhook apply 401 retry. */
	| {
			use: 'integration-refresh'
			name: string
			userEmail?: string
			packageKodyId?: string | null
			waitUntil?: (promise: Promise<unknown>) => void
	  }
	/** `kody.mcp.<server>.<tool>`: a tool call on the org's MCP hub. */
	| {
			use: 'mcp-connection'
			serverId: string
			serverName: string
			waitUntil?: (promise: Promise<unknown>) => void
	  }

export type ResolvedPackageSecretMount = {
	alias: string
	name: string
	/** Opaque `{{secret:…}}` ref. Plaintext never leaves the host. */
	ref: string
	scope: SecretScope
	packageId: string
	kodyId: string
}

export type McpServerConnection = {
	callTool(input: {
		toolName: string
		args: Record<string, unknown>
	}): Promise<CallToolResult>
}

type ResolvedCredentialByUse = {
	secret: ResolvedSecret
	'package-secret-mount': ResolvedPackageSecretMount
	'webhook-secret': ResolvedSecret
	'provider-secret': ResolvedProviderSecret
	'integration-token': string | null
	'integration-refresh': IntegrationTokenRefreshResult
	'mcp-connection': McpServerConnection
}

export type ResolvedCredential<T extends CredentialTarget> =
	ResolvedCredentialByUse[T['use']]

export type ResolveCredentialInput<T extends CredentialTarget> = {
	env: Env
	/** The org that owns the credential. */
	orgId: OwnerId
	/**
	 * The run's request context. Null only on platform paths that have no
	 * run (webhook ingress verification); those need an attested stamp.
	 */
	actor: RequestContext | null
	packageStamp?: PackageStamp | null
	/** App origin for approval links in denial messages. */
	baseUrl: string
	credential: T
}

export async function resolveCredential<T extends CredentialTarget>(
	input: ResolveCredentialInput<T>,
): Promise<ResolvedCredential<T>> {
	const subject = auditSubjectFor(input.credential)
	const audit = (outcome: CredentialResolutionOutcome) =>
		scheduleCredentialResolutionAudit({
			env: input.env,
			orgId: input.orgId,
			actor: input.actor,
			packageStamp: input.packageStamp,
			subject,
			outcome,
		})
	let result: AnyResolvedCredential
	try {
		await assertActorHasOrgAccess(input)
		result = await resolveTarget(input, input.credential, subject)
	} catch (error) {
		audit(credentialResolutionOutcomeForError(error))
		const enablementId = enablementIdOf(input.actor)
		if (enablementId && error instanceof AuthorizationError) {
			await pauseEnablementOnDenial({
				db: input.env.APP_DB,
				orgId: input.orgId,
				enablementId,
				error,
			})
		}
		throw error
	}
	audit(
		isResolved(input.credential, result)
			? { result: 'success' }
			: { result: 'failure', reason: 'not_found' },
	)
	return result as ResolvedCredential<T>
}

type AnyResolvedCredential =
	ResolvedCredentialByUse[keyof ResolvedCredentialByUse]

function auditSubjectFor(credential: CredentialTarget): CredentialAuditSubject {
	switch (credential.use) {
		case 'secret':
			return {
				use: credential.use,
				resourceType: 'secret',
				resourceKey: credential.name,
				details: { host: credential.requestHost ?? null },
			}
		case 'webhook-secret':
			return {
				use: credential.use,
				resourceType: 'secret',
				resourceKey: credential.name,
			}
		case 'package-secret-mount':
			// The mounted secret's name replaces the alias once the mount loads.
			return {
				use: credential.use,
				resourceType: 'secret',
				resourceKey: credential.alias,
				details: { mountAlias: credential.alias },
			}
		case 'provider-secret':
			return {
				use: credential.use,
				resourceType: 'secret-provider',
				// Validated inside the audited resolve; building the subject must not throw.
				resourceKey: credential.provider.trim().toLowerCase(),
				details: { host: credential.requestHost ?? null },
			}
		case 'integration-token':
			return {
				use: credential.use,
				resourceType: 'integration',
				resourceKey: credential.name,
				details: { host: credential.requestHost ?? null },
			}
		case 'integration-refresh':
			return {
				use: credential.use,
				resourceType: 'integration',
				resourceKey: credential.name,
			}
		case 'mcp-connection':
			return {
				use: credential.use,
				resourceType: 'mcp-server',
				resourceKey: credential.serverName,
				details: { serverId: credential.serverId },
			}
		default: {
			const exhaustive: never = credential
			throw new Error(
				`Unhandled credential use: ${String((exhaustive as CredentialTarget).use)}`,
			)
		}
	}
}

function isResolved(
	credential: CredentialTarget,
	result: AnyResolvedCredential,
): boolean {
	switch (credential.use) {
		case 'secret':
		case 'webhook-secret': {
			const secret = result as ResolvedSecret
			return secret.found && typeof secret.value === 'string'
		}
		case 'integration-token':
			return result !== null
		case 'package-secret-mount':
		case 'provider-secret':
		case 'integration-refresh':
		case 'mcp-connection':
			return true
		default: {
			const exhaustive: never = credential
			throw new Error(
				`Unhandled credential use: ${String((exhaustive as CredentialTarget).use)}`,
			)
		}
	}
}

async function resolveTarget(
	input: ResolveCredentialInput<CredentialTarget>,
	credential: CredentialTarget,
	subject: CredentialAuditSubject,
): Promise<AnyResolvedCredential> {
	switch (credential.use) {
		case 'secret':
			return await resolvePlaceholderSecret(input, credential)
		case 'package-secret-mount':
			return await resolvePackageSecretMount(input, credential, subject)
		case 'webhook-secret':
			return await resolveWebhookSecret(input, credential)
		case 'provider-secret':
			return await resolveVaultSecret(input, credential)
		case 'integration-token':
			return await resolveIntegrationToken(input, credential)
		case 'integration-refresh':
			return await refreshIntegration(input, credential)
		case 'mcp-connection':
			return await connectMcpServer(input, credential)
		default: {
			const exhaustive: never = credential
			throw new Error(
				`Unhandled credential use: ${String((exhaustive as CredentialTarget).use)}`,
			)
		}
	}
}

const orgAccessByRequest = new WeakMap<RequestContext, Promise<void>>()

function permissionForUse(use: CredentialTarget['use']): OrgPermission {
	switch (use) {
		case 'secret':
		case 'package-secret-mount':
		case 'webhook-secret':
		case 'provider-secret':
			return 'secret:use'
		case 'integration-token':
		case 'integration-refresh':
		case 'mcp-connection':
			return 'integration:use'
		default: {
			const exhaustive: never = use
			throw new Error(`Unhandled credential use: ${String(exhaustive)}`)
		}
	}
}

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
			// Package apps run as the org's own account (actor id = org id), which
			// has no membership row in a team org; only the org's status applies.
			const hasAccess =
				String(person.userId) === String(input.orgId)
					? await isOrgActive(input.env.APP_DB, input.orgId)
					: (await loadOrgBindingForOrg(
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

function secretResource(orgId: OwnerId, name: string): OrgResource {
	return {
		type: 'secret',
		id: name,
		orgId,
		label: name,
	}
}

/** MCP servers are still checked as the integration resource of their name. */
function integrationResource(orgId: OwnerId, name: string): OrgResource {
	return {
		type: 'integration',
		id: name,
		orgId,
		label: name,
	}
}

/**
 * Ad-hoc code and claimed package stamps need Use on the concrete credential.
 * Attested package runs use package rules as the grant (ADR 0021, amended),
 * except enablement runs: a trigger resolves an org credential only while
 * its enabler has Use on it.
 */
async function authorizeActorUse(
	input: ResolveCredentialInput<CredentialTarget>,
	permission: 'secret:use' | 'integration:use',
	resource: OrgResource,
) {
	if (input.packageStamp?.kind === 'attested' && !enablementIdOf(input.actor)) {
		return
	}
	await authorize(
		{ env: input.env, request: input.actor },
		permission,
		resource,
	)
}

async function resolvePlaceholderSecret(
	input: ResolveCredentialInput<CredentialTarget>,
	credential: Extract<CredentialTarget, { use: 'secret' }>,
): Promise<ResolvedSecret> {
	await authorizeActorUse(
		input,
		'secret:use',
		secretResource(input.orgId, credential.name),
	)
	const resolved = await resolveSecret({
		env: input.env,
		userId: input.orgId,
		name: credential.name,
		scope: credential.scope,
		storageContext: credential.storageContext,
	})
	if (!resolved.found || typeof resolved.value !== 'string') return resolved
	await assertPackageCanAccessResolvedSecret({
		env: input.env,
		baseUrl: input.baseUrl,
		orgSlug: credential.orgSlug,
		userId: input.orgId,
		storageContext: credential.storageContext,
		authorityPackageId: input.packageStamp?.packageId ?? null,
		secretName: credential.name,
		resolved,
	})
	if (
		credential.requestHost &&
		!resolved.allowedHosts.includes(credential.requestHost)
	) {
		throw new SecretHostNotApprovedError({
			secretName: credential.name,
			host: credential.requestHost,
			scope: resolved.scope ?? credential.scope ?? 'user',
		})
	}
	return resolved
}

async function resolvePackageSecretMount(
	input: ResolveCredentialInput<CredentialTarget>,
	credential: Extract<CredentialTarget, { use: 'package-secret-mount' }>,
	subject: CredentialAuditSubject,
): Promise<ResolvedPackageSecretMount> {
	const packageId = input.packageStamp?.packageId ?? ''
	if (!packageId) {
		throw new Error(
			'Package secret access requires a matching server-side package runtime context.',
		)
	}
	if (!input.orgId) {
		throw new Error(
			'Package secret access requires an authenticated package caller context.',
		)
	}
	const callerContext = credential.callerContext
	const packageInfo = await loadPackageSecretMounts({
		env: input.env,
		baseUrl: input.baseUrl,
		userId: input.orgId,
		packageId,
	})
	const mount = packageInfo.mounts[credential.alias]
	if (!mount) {
		throw new PackageSecretMountError(
			`Package "${packageInfo.savedPackage.kodyId}" does not declare secret mount "${credential.alias}".`,
		)
	}
	subject.resourceKey = mount.name
	await authorizeActorUse(
		input,
		'secret:use',
		secretResource(input.orgId, mount.name),
	)
	const storageContext: StorageContext = {
		sessionId: callerContext.storageContext?.sessionId ?? null,
		appId: callerContext.storageContext?.appId ?? null,
		packageId,
		storageId: callerContext.storageContext?.storageId ?? null,
	}
	const resolved = await resolveSecret({
		env: input.env,
		userId: input.orgId,
		name: mount.name,
		scope: mount.scope,
		storageContext,
	})
	if (!resolved.found || typeof resolved.value !== 'string') {
		throw new PackageSecretMissingError(
			await createUnresolvedSecretMessage({
				env: input.env,
				userId: input.orgId,
				name: mount.name,
				scope: mount.scope,
				storageContext,
				baseUrl: input.baseUrl,
			}),
		)
	}
	await assertPackageCanAccessResolvedSecret({
		env: input.env,
		baseUrl: input.baseUrl,
		orgSlug: secretPageOrgSlugFromCaller(callerContext),
		userId: input.orgId,
		storageContext,
		authorityPackageId: packageId,
		secretName: mount.name,
		resolved,
	})
	// The placeholder carries name+scope only, never the owner id (that would
	// be caller-forgeable).
	const scope = resolved.scope ?? mount.scope ?? 'user'
	return {
		alias: credential.alias,
		name: mount.name,
		ref: buildSecretPlaceholder({ name: mount.name, scope }),
		scope,
		packageId: packageInfo.savedPackage.id,
		kodyId: packageInfo.savedPackage.kodyId,
	}
}

async function resolveWebhookSecret(
	input: ResolveCredentialInput<CredentialTarget>,
	credential: Extract<CredentialTarget, { use: 'webhook-secret' }>,
): Promise<ResolvedSecret> {
	await authorizeActorUse(
		input,
		'secret:use',
		secretResource(input.orgId, credential.name),
	)
	return await resolveSecret({
		env: input.env,
		userId: input.orgId,
		name: credential.name,
		storageContext: {
			sessionId: null,
			appId: null,
			packageId: input.packageStamp?.packageId ?? null,
		},
	})
}

async function resolveVaultSecret(
	input: ResolveCredentialInput<CredentialTarget>,
	credential: Extract<CredentialTarget, { use: 'provider-secret' }>,
): Promise<ResolvedProviderSecret> {
	const request = input.actor
	if (!request) {
		throw new Error('Provider secrets require the fetching run request.')
	}
	const binding = await getSecretProviderBinding(input.env.APP_DB, {
		userId: input.orgId,
		providerId: normalizeProviderId(credential.provider),
	})
	// The door key is the credential: Use on it before any decrypt or
	// provider invoke. A missing binding fails inside resolveProviderSecret.
	if (binding) {
		await authorizeActorUse(
			input,
			'secret:use',
			secretResource(input.orgId, binding.doorSecretName),
		)
	}
	const resolved = await resolveProviderSecret({
		env: input.env,
		baseUrl: input.baseUrl,
		userId: input.orgId,
		request,
		provider: credential.provider,
		ref: credential.ref,
		storageContext: credential.storageContext,
		// Claimed packages are held to their grants too; only Use differs.
		authorityPackageId: input.packageStamp?.packageId ?? null,
		invokeProvider: invokeSealedSecretProvider,
	})
	const host = credential.requestHost
	if (host) {
		if (resolved.hosts.length === 0) {
			throw new SecretProviderHostDeniedError(
				createProviderNoWebsitesMessage(resolved.provider),
			)
		}
		if (!providerHostsAllowRequestHost(resolved.hosts, host)) {
			throw new SecretProviderHostDeniedError(
				createProviderHostDeniedMessage({
					providerId: resolved.provider,
					host,
				}),
			)
		}
	}
	return resolved
}

async function resolveIntegrationToken(
	input: ResolveCredentialInput<CredentialTarget>,
	credential: Extract<CredentialTarget, { use: 'integration-token' }>,
): Promise<string | null> {
	await authorizeActorUse(
		input,
		'integration:use',
		integrationResource(input.orgId, credential.name),
	)
	await assertCanUseIntegration({
		env: input.env,
		baseUrl: input.baseUrl,
		userId: input.orgId,
		name: credential.name,
		packageId: input.packageStamp?.packageId ?? null,
		packageKodyId: credential.packageKodyId,
	})
	const token = await resolveIntegrationAccessToken({
		env: input.env,
		userId: input.orgId,
		name: credential.name,
	})
	if (token && credential.requestHost) {
		const joined = await getJoinedIntegration({
			env: input.env,
			userId: input.orgId,
			name: credential.name,
		})
		if (!joined) {
			throw new Error(
				createMissingIntegrationAccessTokenMessage(credential.name),
			)
		}
		assertIntegrationAllowsHost(
			credential.name,
			{
				requiredHosts: joined.connection.requiredHosts,
				apiBaseUrl: joined.app.apiBaseUrl,
			},
			credential.requestHost,
		)
	}
	return token
}

async function refreshIntegration(
	input: ResolveCredentialInput<CredentialTarget>,
	credential: Extract<CredentialTarget, { use: 'integration-refresh' }>,
): Promise<IntegrationTokenRefreshResult> {
	await authorizeActorUse(
		input,
		'integration:use',
		integrationResource(input.orgId, credential.name),
	)
	await assertCanUseIntegration({
		env: input.env,
		baseUrl: input.baseUrl,
		userId: input.orgId,
		name: credential.name,
		packageId: input.packageStamp?.packageId ?? null,
		packageKodyId: credential.packageKodyId,
	})
	return await refreshIntegrationTokens({
		env: input.env,
		userId: input.orgId,
		userEmail: credential.userEmail,
		name: credential.name,
		waitUntil: credential.waitUntil,
	})
}

async function connectMcpServer(
	input: ResolveCredentialInput<CredentialTarget>,
	credential: Extract<CredentialTarget, { use: 'mcp-connection' }>,
): Promise<McpServerConnection> {
	await authorizeActorUse(
		input,
		'integration:use',
		integrationResource(input.orgId, credential.serverName),
	)
	await assertCanUseMcpServer({
		env: input.env,
		baseUrl: input.baseUrl,
		userId: input.orgId,
		serverId: credential.serverId,
		serverName: credential.serverName,
		packageId: input.packageStamp?.packageId ?? null,
	})
	return {
		async callTool(call) {
			return await callMcpServerTool({
				env: input.env,
				userId: input.orgId,
				waitUntil: credential.waitUntil,
				serverId: credential.serverId,
				toolName: call.toolName,
				args: call.args,
			})
		},
	}
}
