/**
 * The request context: one shape for every request source. `org` decides
 * whose data a request touches (every storage key follows it); `actor` and
 * `attribution` decide who is acting and who pays; `credential` is what
 * authenticated the request and may narrow it. `authorize` reads only this
 * shape. See docs/contributing/architecture/authorization.md.
 */
import { type OrgPermission } from './org-permissions.ts'
import { type OwnerId, type PersonId } from './owner-person-ids.ts'

export type OrgRole = 'owner' | 'member' | 'billing'

export type RequestOrg = {
	id: OwnerId
	/** Public handle. Null only when the identity row has no valid username. */
	slug: string | null
}

export type RequestActor = {
	userId: PersonId
	username: string | null
}

/**
 * `event` covers platform-originated topics (status incidents, fleet
 * alerts) that reach a subscriber package with no emitting run.
 */
export type AutomationSource = 'webhook' | 'schedule' | 'email' | 'event'

export type RequestAttribution =
	| { kind: 'user'; userId: PersonId }
	| { kind: 'automation'; source: AutomationSource; sourceId: string }

export type RequestCredentialKind =
	| 'session'
	| 'mcp-oauth'
	| 'api-token'
	| 'cli'
	| 'package-app'
	| 'inbound-email'
	| 'webhook'
	| 'schedule'
	| 'platform-event'

export type RequestCredential = {
	kind: RequestCredentialKind
	id: string | null
	/** The org this credential is bound to. */
	orgId: OwnerId
	/** Null means the credential does not narrow the actor's permissions. */
	scopes: ReadonlyArray<OrgPermission> | null
	/** Connection profile that narrows this credential to listed resources. */
	profileName: string | null
}

export type RequestContext = {
	org: RequestOrg
	/** Null only for Automation (webhook, schedule, email, event). */
	actor: RequestActor | null
	attribution: RequestAttribution
	credential: RequestCredential
	/** Null for Automation and for outside collaborators. */
	membership: { role: OrgRole } | null
}

/**
 * The parts of a request context a downstream run inherits from the run
 * that started it (nested invokes, workflow steps, emitted package events,
 * sealed secret providers). The org is always re-resolved, never inherited.
 */
export type RequestLineage = Pick<
	RequestContext,
	'actor' | 'attribution' | 'credential'
>
