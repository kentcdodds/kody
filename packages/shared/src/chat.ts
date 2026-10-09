import {
	array,
	literal,
	nullable,
	object,
	optional,
	string,
	type InferOutput,
	union,
} from 'remix/data-schema'
import { type OwnerId, type PersonId } from './owner-person-ids.ts'

export const mcpUserContextSchema = object({
	userId: string(),
	email: string(),
	username: optional(string()),
	displayName: string(),
	roles: optional(array(string())),
	permissions: optional(array(string())),
})

export const mcpStorageContextSchema = object({
	sessionId: optional(nullable(string())),
	appId: optional(nullable(string())),
	packageId: optional(nullable(string())),
	storageId: optional(nullable(string())),
})

export const mcpRepoContextSchema = object({
	sourceId: optional(nullable(string())),
	repoId: optional(nullable(string())),
	sessionId: optional(nullable(string())),
	baseCommit: optional(nullable(string())),
	manifestPath: optional(nullable(string())),
	sourceRoot: optional(nullable(string())),
	publishedCommit: optional(nullable(string())),
	entityKind: optional(nullable(string())),
	entityId: optional(nullable(string())),
})

export const mcpExecutionOriginSchema = union([
	literal('interactive'),
	literal('background'),
])

export const mcpCallerContextSchema = object({
	baseUrl: string(),
	executionOrigin: optional(mcpExecutionOriginSchema),
	user: optional(nullable(mcpUserContextSchema)),
	storageContext: optional(nullable(mcpStorageContextSchema)),
	repoContext: optional(nullable(mcpRepoContextSchema)),
	/**
	 * Named connection profile bound to this MCP OAuth grant or API token.
	 * Absent / null = unlimited (today's default connection). Present = the
	 * profile's grant allowlist (empty allowlist denies everything).
	 */
	connectionProfileName: optional(nullable(string())),
})

type McpUserContextInferred = InferOutput<typeof mcpUserContextSchema>

export type McpUserContext = Omit<
	McpUserContextInferred,
	'userId' | 'roles' | 'permissions' | 'username'
> & {
	/** The signed-in person. Read `McpCallerContext.actor` / `.owner` instead. */
	userId: PersonId
	username?: string
	roles?: Array<string>
	permissions?: Array<string>
}
export type McpStorageContext = InferOutput<typeof mcpStorageContextSchema>
export type McpRepoContext = InferOutput<typeof mcpRepoContextSchema>
export type McpExecutionOrigin = InferOutput<typeof mcpExecutionOriginSchema>
type McpCallerContextInferred = InferOutput<typeof mcpCallerContextSchema>

/**
 * The serializable caller context: what crosses worker boundaries and what
 * jobs persist in `caller_context_json`. Carries no derived identity.
 */
export type McpCallerContextWire = Omit<
	McpCallerContextInferred,
	'user' | 'connectionProfileName'
> & {
	user?: McpUserContext | null
	connectionProfileName?: string | null
}

/**
 * A caller context with resolved identities. `actor` is the person acting
 * (audit, RBAC, attribution); `owner` is the org whose data the call reads and
 * writes (storage). `createMcpCallerContext` and `parseMcpCallerContext` derive both
 * from `user`; they are never read from serialized input.
 */
export type McpCallerContext = McpCallerContextWire & {
	actor: PersonId | null
	owner: OwnerId | null
}
