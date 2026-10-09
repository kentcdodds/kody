import { type McpUserContext } from '@kody-internal/shared/chat.ts'
import { isRecord } from '@kody-internal/shared/is-record.ts'
import { isOrgPermission } from '@kody-internal/shared/org-permissions.ts'
import {
	personalOrgId,
	personIdFromStored,
	ownerIdFromStored,
} from '@kody-internal/shared/owner-person-ids.ts'
import {
	type AutomationSource,
	type OrgRole,
	type RequestActor,
	type RequestAttribution,
	type RequestContext,
	type RequestCredential,
	type RequestCredentialKind,
	type RequestLineage,
	type RequestOrg,
} from '@kody-internal/shared/request-context.ts'

/**
 * How a request reached Kody. Every place that builds a caller context names
 * its source, and `deriveRequestContext` turns it into the one shape
 * `authorize` reads.
 */
export type RequestSource =
	| { kind: 'session' }
	| { kind: 'mcp-oauth' }
	| { kind: 'cli' }
	| { kind: 'api-token'; tokenId: string }
	| { kind: 'package-app' }
	| { kind: 'schedule'; jobId: string }
	| { kind: 'webhook'; sourceId: string }
	| { kind: 'inbound-email'; sourceId: string }
	| { kind: 'platform-event'; sourceId: string }
	/** Nested invokes, workflow steps, package events, sealed providers. */
	| { kind: 'inherited'; lineage: RequestLineage }

/** The identity fields a request context is derived from. */
type RequestPerson = Pick<McpUserContext, 'userId' | 'username'>

export type RequestOrgBinding = {
	org: RequestOrg
	/** Null for grant-only outside collaborators. */
	role: OrgRole | null
}

/**
 * Which org a person acts in, and with which role. This is the only place
 * that decides it: every person acts in their implicit org, whose id is
 * their `stable_user_id`, as its Owner. Org memberships replace this body;
 * callers do not change.
 */
function resolveOrgBinding(user: RequestPerson): RequestOrgBinding {
	return {
		org: {
			id: personalOrgId(user.userId),
			slug: user.username?.trim() || null,
		},
		role: 'owner',
	}
}

function actorFor(user: RequestPerson): RequestActor {
	return { userId: user.userId, username: user.username?.trim() || null }
}

function credentialFor(input: {
	kind: RequestCredentialKind
	id: string | null
	org: RequestOrg
	profileName: string | null
	scopes?: RequestCredential['scopes']
}): RequestCredential {
	return {
		kind: input.kind,
		id: input.id,
		orgId: input.org.id,
		scopes: input.scopes ?? null,
		profileName: input.profileName,
	}
}

function automation(input: {
	binding: RequestOrgBinding
	source: AutomationSource
	sourceId: string
	credentialKind: RequestCredentialKind
	profileName: string | null
}): RequestContext {
	return {
		org: input.binding.org,
		actor: null,
		attribution: {
			kind: 'automation',
			source: input.source,
			sourceId: input.sourceId,
		},
		credential: credentialFor({
			kind: input.credentialKind,
			id: input.sourceId,
			org: input.binding.org,
			profileName: input.profileName,
		}),
		membership: null,
	}
}

/**
 * Build the request context for `user` reached through `source`.
 * `user` is the identity the caller context carries: the signed-in person
 * for interactive sources, and the org's owning account for Automation.
 */
export function deriveRequestContext(input: {
	user: RequestPerson
	source: RequestSource
	profileName?: string | null
	/** When set (DB-backed session paths), overrides {@link resolveOrgBinding}. */
	orgBinding?: RequestOrgBinding
	/** Credential scopes. Populated for API tokens; null does not narrow. */
	scopes?: RequestCredential['scopes']
}): RequestContext {
	const binding = input.orgBinding ?? resolveOrgBinding(input.user)
	const { source } = input
	const profileName = input.profileName?.trim() || null
	switch (source.kind) {
		case 'session':
		case 'mcp-oauth':
		case 'cli':
		case 'api-token':
		case 'package-app': {
			const actor = actorFor(input.user)
			return {
				org: binding.org,
				actor,
				attribution: { kind: 'user', userId: actor.userId },
				credential: credentialFor({
					kind: source.kind,
					id: source.kind === 'api-token' ? source.tokenId : null,
					org: binding.org,
					profileName,
					scopes: input.scopes ?? null,
				}),
				membership: binding.role ? { role: binding.role } : null,
			}
		}
		case 'schedule':
			return automation({
				binding,
				source: 'schedule',
				sourceId: source.jobId,
				credentialKind: 'schedule',
				profileName,
			})
		case 'webhook':
			return automation({
				binding,
				source: 'webhook',
				sourceId: source.sourceId,
				credentialKind: 'webhook',
				profileName,
			})
		case 'inbound-email':
			return automation({
				binding,
				source: 'email',
				sourceId: source.sourceId,
				credentialKind: 'inbound-email',
				profileName,
			})
		case 'platform-event':
			return automation({
				binding,
				source: 'event',
				sourceId: source.sourceId,
				credentialKind: 'platform-event',
				profileName,
			})
		case 'inherited': {
			const { lineage } = source
			return {
				org: binding.org,
				actor: lineage.actor,
				attribution: lineage.attribution,
				credential: {
					...lineage.credential,
					profileName: lineage.credential.profileName ?? profileName,
				},
				membership:
					lineage.actor && binding.role ? { role: binding.role } : null,
			}
		}
		default: {
			const exhaustive: never = source
			throw new Error(`Unhandled request source: ${String(exhaustive)}`)
		}
	}
}

/** What a downstream run started by `request` inherits from it. */
export function requestLineage(request: RequestContext): RequestLineage {
	return {
		actor: request.actor,
		attribution: request.attribution,
		credential: request.credential,
	}
}

export function inheritRequest(request: RequestContext): RequestSource {
	return { kind: 'inherited', lineage: requestLineage(request) }
}

const credentialKinds: ReadonlySet<string> = new Set<RequestCredentialKind>([
	'session',
	'mcp-oauth',
	'api-token',
	'cli',
	'package-app',
	'inbound-email',
	'webhook',
	'schedule',
	'platform-event',
])

const automationSources: ReadonlySet<string> = new Set<AutomationSource>([
	'webhook',
	'schedule',
	'email',
	'event',
])

function readNullableString(value: unknown) {
	return typeof value === 'string' && value.trim() ? value : null
}

function parseAttribution(value: unknown): RequestAttribution | null {
	if (!isRecord(value)) return null
	if (value.kind === 'user' && typeof value.userId === 'string') {
		return { kind: 'user', userId: personIdFromStored(value.userId) }
	}
	if (
		value.kind === 'automation' &&
		typeof value.source === 'string' &&
		automationSources.has(value.source) &&
		typeof value.sourceId === 'string'
	) {
		return {
			kind: 'automation',
			source: value.source as AutomationSource,
			sourceId: value.sourceId,
		}
	}
	return null
}

/**
 * Read a lineage persisted across a durable boundary (workflow payloads,
 * queue messages). Returns null for anything malformed; the caller fails
 * closed.
 */
export function parseRequestLineage(value: unknown): RequestLineage | null {
	if (!isRecord(value)) return null
	const attribution = parseAttribution(value.attribution)
	if (!attribution) return null
	const credential = value.credential
	if (
		!isRecord(credential) ||
		typeof credential.kind !== 'string' ||
		!credentialKinds.has(credential.kind) ||
		typeof credential.orgId !== 'string'
	) {
		return null
	}
	const scopes = credential.scopes
	if (
		scopes !== null &&
		!(Array.isArray(scopes) && scopes.every((scope) => isOrgPermission(scope)))
	) {
		return null
	}
	const actorValue = value.actor
	let actor: RequestActor | null = null
	if (actorValue !== null) {
		if (!isRecord(actorValue) || typeof actorValue.userId !== 'string') {
			return null
		}
		actor = {
			userId: personIdFromStored(actorValue.userId),
			username: readNullableString(actorValue.username),
		}
	}
	return {
		actor,
		attribution,
		credential: {
			kind: credential.kind as RequestCredentialKind,
			id: readNullableString(credential.id),
			orgId: ownerIdFromStored(credential.orgId),
			scopes: scopes as RequestCredential['scopes'],
			profileName: readNullableString(credential.profileName),
		},
	}
}
