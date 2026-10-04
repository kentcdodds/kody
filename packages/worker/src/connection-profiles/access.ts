import { type McpCallerContext } from '@kody-internal/shared/chat.ts'
import {
	type ConnectionProfileAction,
	type ConnectionProfileGrant,
} from '#universal/connection-profiles/grants.ts'
import { connectionProfilesFlagKey } from '#universal/feature-flags/registry.ts'
import { McpCallerError } from '#mcp/caller-error.ts'
import { resolveCallerFeatureFlags } from '#mcp/capabilities/access-control.ts'
import {
	profileGrantsAllow,
	profileGrantsReveal,
	resolveConnectionProfileGrants,
} from './repo.ts'
import { runWithConnectionProfileGrants } from './request-grants.ts'

export async function withCallerConnectionProfileGrants<T>(input: {
	env: Env
	callerContext: McpCallerContext
	run: () => Promise<T>
}): Promise<T> {
	const actor = await resolveConnectionProfileActor(input)
	return await runWithConnectionProfileGrants(actor.grants, input.run)
}

export type ConnectionProfileActor = {
	/** Absent / null = unlimited. Present (including empty grants) = allowlist. */
	grants: ReadonlyArray<ConnectionProfileGrant> | null
	profileName: string | null
}

/**
 * Read the profile name stamped on an MCP OAuth grant or API token principal.
 * Stored on caller context when the connection-profiles flag is on.
 */
export function readCallerConnectionProfileName(
	callerContext: McpCallerContext,
): string | null {
	const value = callerContext.connectionProfileName
	if (typeof value !== 'string') return null
	const trimmed = value.trim()
	return trimmed.length > 0 ? trimmed : null
}

export async function resolveConnectionProfileActor(input: {
	env: Env
	callerContext: McpCallerContext
}): Promise<ConnectionProfileActor> {
	const profileName = readCallerConnectionProfileName(input.callerContext)
	if (!profileName) {
		return { grants: null, profileName: null }
	}
	const userId = input.callerContext.user?.userId
	if (!userId) {
		return { grants: [], profileName }
	}
	const flags = await resolveCallerFeatureFlags(input.env, input.callerContext)
	if (flags[connectionProfilesFlagKey] !== true) {
		// Non-experimenters: ignore unknown profile bindings; keep unlimited.
		return { grants: null, profileName: null }
	}
	const grants = await resolveConnectionProfileGrants({
		db: input.env.APP_DB,
		userId,
		profileName,
	})
	return { grants, profileName }
}

/**
 * One check: can this actor do this action on this resource?
 * Profile grants are an input; unlimited (no profile) does not restrict.
 */
export async function callerCanAccessResource(input: {
	env: Env
	callerContext: McpCallerContext
	resourceType: string
	resourceId: string
	action: ConnectionProfileAction
}): Promise<boolean> {
	const actor = await resolveConnectionProfileActor(input)
	return profileGrantsAllow({
		grants: actor.grants,
		resourceType: input.resourceType,
		resourceId: input.resourceId,
		action: input.action,
	})
}

export async function assertCallerCanAccessResource(input: {
	env: Env
	callerContext: McpCallerContext
	resourceType: string
	resourceId: string
	action: ConnectionProfileAction
}): Promise<void> {
	const allowed = await callerCanAccessResource(input)
	if (allowed) return
	throw new McpCallerError(
		`This connection profile cannot ${input.action} ${input.resourceType} "${input.resourceId}".`,
	)
}

export async function callerCanRevealResource(input: {
	env: Env
	callerContext: McpCallerContext
	resourceType: string
	resourceId: string
}): Promise<boolean> {
	const actor = await resolveConnectionProfileActor(input)
	return profileGrantsReveal({
		grants: actor.grants,
		resourceType: input.resourceType,
		resourceId: input.resourceId,
	})
}

export async function filterResourceIdsForCallerProfile(input: {
	env: Env
	callerContext: McpCallerContext
	resourceType: string
	resourceIds: ReadonlyArray<string>
}): Promise<Array<string> | null> {
	const actor = await resolveConnectionProfileActor(input)
	if (actor.grants == null) return null
	return input.resourceIds.filter((resourceId) =>
		profileGrantsReveal({
			grants: actor.grants,
			resourceType: input.resourceType,
			resourceId,
		}),
	)
}
